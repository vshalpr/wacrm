import { describe, it, expect } from "vitest";
import {
  calculateSeatUsage,
  fetchAccountSeatUsage,
  countPendingInvitations,
  countActiveMembers,
  DEFAULT_MAX_USERS,
} from "./user-limits";

describe("calculateSeatUsage", () => {
  it("uses defaults when maxUsers or planTier are missing", () => {
    const usage = calculateSeatUsage({
      maxUsers: null,
      planTier: null,
      activeMembersCount: 1,
      pendingInvitesCount: 0,
    });

    expect(usage.max_users).toBe(DEFAULT_MAX_USERS);
    expect(usage.plan_tier).toBe("starter");
    expect(usage.active_members).toBe(1);
    expect(usage.pending_invites).toBe(0);
    expect(usage.total_used).toBe(1);
    expect(usage.seats_remaining).toBe(0);
    expect(usage.is_limit_reached).toBe(true);
  });

  it("calculates multi-seat plan correctly with available seats", () => {
    const usage = calculateSeatUsage({
      maxUsers: 5,
      planTier: "team",
      activeMembersCount: 2,
      pendingInvitesCount: 1,
    });

    expect(usage.max_users).toBe(5);
    expect(usage.plan_tier).toBe("team");
    expect(usage.active_members).toBe(2);
    expect(usage.pending_invites).toBe(1);
    expect(usage.total_used).toBe(3);
    expect(usage.seats_remaining).toBe(2);
    expect(usage.is_limit_reached).toBe(false);
  });

  it("identifies when seat limit is exactly reached", () => {
    const usage = calculateSeatUsage({
      maxUsers: 5,
      planTier: "team",
      activeMembersCount: 3,
      pendingInvitesCount: 2,
    });

    expect(usage.total_used).toBe(5);
    expect(usage.seats_remaining).toBe(0);
    expect(usage.is_limit_reached).toBe(true);
  });

  it("handles custom dynamic user limit (e.g. 15 users)", () => {
    const usage = calculateSeatUsage({
      maxUsers: 15,
      planTier: "custom",
      activeMembersCount: 4,
      pendingInvitesCount: 2,
    });

    expect(usage.max_users).toBe(15);
    expect(usage.plan_tier).toBe("custom");
    expect(usage.total_used).toBe(6);
    expect(usage.seats_remaining).toBe(9);
    expect(usage.is_limit_reached).toBe(false);
  });

  it("clamps negative seats remaining to 0 if overflowed", () => {
    const usage = calculateSeatUsage({
      maxUsers: 2,
      planTier: "starter",
      activeMembersCount: 3,
      pendingInvitesCount: 1,
    });

    expect(usage.total_used).toBe(4);
    expect(usage.seats_remaining).toBe(0);
    expect(usage.is_limit_reached).toBe(true);
  });
});

describe("fetchAccountSeatUsage and count helpers", () => {
  function makeMockClient(opts: {
    profilesCount?: number;
    profilesErr?: unknown;
    invitesCount?: number;
    invitesErr?: unknown;
  }) {
    const queries: { table: string; filters: Record<string, unknown> }[] = [];

    const from = (table: string) => {
      const currentQuery = { table, filters: {} as Record<string, unknown> };
      queries.push(currentQuery);

      const builder = {
        select: (_cols?: string, _options?: unknown) => builder,
        eq: (col: string, val: unknown) => {
          currentQuery.filters[col] = val;
          return builder;
        },
        is: (col: string, val: unknown) => {
          currentQuery.filters[col] = val;
          return builder;
        },
        gt: (col: string, val: unknown) => {
          currentQuery.filters[`${col}_gt`] = val;
          return builder;
        },
        then: (
          onfulfilled?: (value: { count: number | null; error: unknown }) => unknown,
        ) => {
          const res =
            table === "profiles"
              ? { count: opts.profilesCount ?? 0, error: opts.profilesErr ?? null }
              : { count: opts.invitesCount ?? 0, error: opts.invitesErr ?? null };
          return Promise.resolve(res).then(onfulfilled);
        },
      };
      return builder;
    };

    return { client: { from } as any, queries };
  }

  it("counts pending invitations with active unexpired filter", async () => {
    const { client, queries } = makeMockClient({ invitesCount: 3 });
    const res = await countPendingInvitations(client, "acct-1");

    expect(res.count).toBe(3);
    expect(res.error).toBeNull();
    expect(queries[0].table).toBe("account_invitations");
    expect(queries[0].filters.account_id).toBe("acct-1");
    expect(queries[0].filters.accepted_at).toBeNull();
  });

  it("counts active members scoped to account", async () => {
    const { client, queries } = makeMockClient({ profilesCount: 4 });
    const res = await countActiveMembers(client, "acct-2");

    expect(res.count).toBe(4);
    expect(res.error).toBeNull();
    expect(queries[0].table).toBe("profiles");
    expect(queries[0].filters.account_id).toBe("acct-2");
  });

  it("computes seat usage end-to-end querying both tables when count not provided", async () => {
    const { client, queries } = makeMockClient({ profilesCount: 3, invitesCount: 1 });
    const { seatUsage, error } = await fetchAccountSeatUsage({
      supabase: client,
      accountId: "acct-3",
      maxUsers: 5,
      planTier: "team",
    });

    expect(error).toBeNull();
    expect(seatUsage).toBeDefined();
    expect(seatUsage?.active_members).toBe(3);
    expect(seatUsage?.pending_invites).toBe(1);
    expect(seatUsage?.total_used).toBe(4);
    expect(seatUsage?.seats_remaining).toBe(1);
    expect(seatUsage?.is_limit_reached).toBe(false);
    expect(queries.map((q) => q.table)).toEqual(["profiles", "account_invitations"]);
  });

  it("skips profile query when activeMembersCount is pre-supplied", async () => {
    const { client, queries } = makeMockClient({ invitesCount: 2 });
    const { seatUsage, error } = await fetchAccountSeatUsage({
      supabase: client,
      accountId: "acct-4",
      maxUsers: 3,
      planTier: "starter",
      activeMembersCount: 1,
    });

    expect(error).toBeNull();
    expect(seatUsage?.active_members).toBe(1);
    expect(seatUsage?.pending_invites).toBe(2);
    expect(seatUsage?.total_used).toBe(3);
    expect(seatUsage?.is_limit_reached).toBe(true);
    // Only account_invitations queried
    expect(queries.map((q) => q.table)).toEqual(["account_invitations"]);
  });

  it("surfaces error when database query fails", async () => {
    const dbErr = new Error("DB connection timeout");
    const { client } = makeMockClient({ invitesErr: dbErr });
    const { seatUsage, error } = await fetchAccountSeatUsage({
      supabase: client,
      accountId: "acct-5",
      maxUsers: 5,
    });

    expect(seatUsage).toBeNull();
    expect(error).toBe(dbErr);
  });
});
