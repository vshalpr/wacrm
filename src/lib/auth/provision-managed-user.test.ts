import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, SupabaseClient } from "@supabase/supabase-js";
import { provisionManagedUser } from "./provision-managed-user";

const mocked = vi.hoisted(() => ({
  rpc: vi.fn(),
  createUser: vi.fn(),
  listUsers: vi.fn(),
  updateUserById: vi.fn(),
  maybeSingle: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
}));

function makeAdmin(): SupabaseClient {
  mocked.rpc.mockResolvedValue({ error: null });
  mocked.createUser.mockReset();
  mocked.listUsers.mockReset();
  mocked.updateUserById.mockResolvedValue({ error: null });
  mocked.maybeSingle.mockResolvedValue({
    data: { account_id: "account-1", account_role: "admin", status: "active" },
    error: null,
  });
  mocked.eq.mockReturnValue({ maybeSingle: mocked.maybeSingle });
  mocked.select.mockReturnValue({ eq: mocked.eq });

  return {
    rpc: mocked.rpc,
    from: () => ({ select: mocked.select }),
    auth: {
      admin: {
        createUser: mocked.createUser,
        listUsers: mocked.listUsers,
        updateUserById: mocked.updateUserById,
      },
    },
  } as unknown as SupabaseClient;
}

function input() {
  return {
    email: "  MEMBER@EXAMPLE.COM ",
    password: "password-123",
    fullName: "Member",
    accountId: "account-1",
    accountRole: "admin" as const,
  };
}

describe("provisionManagedUser ambiguous Auth responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the already-created user when Auth committed the intended membership", async () => {
    const nonce = "a".repeat(64);
    const user = {
      id: "user-1",
      email: "member@example.com",
      user_metadata: { full_name: "Member", managed_provisioning_nonce: nonce },
    } as unknown as AuthUser;
    const authError = Object.assign(new Error("Auth response was lost"), {
      name: "AuthRetryableFetchError",
      status: 0,
    });
    mocked.createUser.mockRejectedValue(authError);
    mocked.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });

    const result = await provisionManagedUser(makeAdmin(), input());

    expect(result).toBe(user);
    expect(mocked.listUsers).toHaveBeenCalledOnce();
    expect(mocked.maybeSingle).toHaveBeenCalledOnce();
    expect(mocked.updateUserById).toHaveBeenCalledWith("user-1", {
      user_metadata: { full_name: "Member" },
    });
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not accept or delete a user whose membership belongs elsewhere", async () => {
    const authError = Object.assign(new Error("Auth timed out"), {
      name: "AuthRetryableFetchError",
      status: 0,
    });
    mocked.createUser.mockRejectedValue(authError);
    mocked.listUsers.mockResolvedValue({
      data: {
        users: [{ id: "user-2", email: "member@example.com", user_metadata: {} }],
      },
      error: null,
    });
    mocked.maybeSingle.mockResolvedValue({
      data: { account_id: "another-account", account_role: "admin", status: "active" },
      error: null,
    });

    await expect(provisionManagedUser(makeAdmin(), input())).rejects.toBe(authError);

    expect(mocked.updateUserById).not.toHaveBeenCalled();
    expect(mocked.createUser).toHaveBeenCalledOnce();
    expect(mocked.rpc).toHaveBeenCalledTimes(2);
    expect(mocked.rpc).toHaveBeenLastCalledWith("cancel_managed_user_provisioning", {
      p_email: "member@example.com",
      p_nonce: expect.any(String),
    });
  });
});
