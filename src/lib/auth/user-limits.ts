// ============================================================
// User & Seat Limits helper functions
//
// Calculates seat usage metrics for accounts based on active
// members, pending non-expired invitations, and the account's
// max_users limit.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SeatUsage } from "@/types";

export const DEFAULT_MAX_USERS = 1;
export const DEFAULT_PLAN_TIER = "starter";

/**
 * Calculate seat utilization for an account.
 *
 * A seat is considered consumed if it is occupied by an active
 * member OR reserved by an active, unexpired invitation.
 */
export function calculateSeatUsage(params: {
  maxUsers?: number | null;
  planTier?: string | null;
  activeMembersCount: number;
  pendingInvitesCount: number;
}): SeatUsage {
  const max_users = Math.max(1, params.maxUsers ?? DEFAULT_MAX_USERS);
  const plan_tier = params.planTier || DEFAULT_PLAN_TIER;
  const active_members = Math.max(0, params.activeMembersCount);
  const pending_invites = Math.max(0, params.pendingInvitesCount);
  const total_used = active_members + pending_invites;
  const seats_remaining = Math.max(0, max_users - total_used);
  const is_limit_reached = total_used >= max_users;

  return {
    max_users,
    plan_tier,
    active_members,
    pending_invites,
    total_used,
    seats_remaining,
    is_limit_reached,
  };
}

/**
 * Counts unredeemed, non-expired invitations for an account.
 */
export async function countPendingInvitations(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ count: number; error: unknown }> {
  const { count, error } = await supabase
    .from("account_invitations")
    .select("*", { count: "exact", head: true })
    .eq("account_id", accountId)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString());

  return { count: count ?? 0, error };
}

/**
 * Counts active members (profiles) for an account.
 */
export async function countActiveMembers(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ count: number; error: unknown }> {
  const { count, error } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("account_id", accountId);

  return { count: count ?? 0, error };
}

/**
 * Fetches member and pending counts and calculates seat usage.
 */
export async function fetchAccountSeatUsage(params: {
  supabase: SupabaseClient;
  accountId: string;
  maxUsers?: number | null;
  planTier?: string | null;
  activeMembersCount?: number;
}): Promise<{ seatUsage: SeatUsage | null; error: unknown }> {
  const { supabase, accountId, maxUsers, planTier } = params;

  let activeMembersCount = params.activeMembersCount;
  let memberErr: unknown = null;

  if (activeMembersCount === undefined) {
    const res = await countActiveMembers(supabase, accountId);
    activeMembersCount = res.count;
    memberErr = res.error;
  }

  const { count: pendingInvitesCount, error: pendingErr } =
    await countPendingInvitations(supabase, accountId);

  const error = memberErr || pendingErr;
  if (error) {
    return { seatUsage: null, error };
  }

  const seatUsage = calculateSeatUsage({
    maxUsers,
    planTier,
    activeMembersCount,
    pendingInvitesCount,
  });

  return { seatUsage, error: null };
}
