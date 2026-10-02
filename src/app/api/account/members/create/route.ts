// ============================================================
// POST /api/account/members/create
//
// Admin-only endpoint to directly create a team member user under
// the caller's account. This prevents the user from creating
// their own team or account.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageMembers } from '@/lib/auth/roles';
import { fetchAccountSeatUsage } from '@/lib/auth/user-limits';
import { provisionManagedUser } from '@/lib/auth/provision-managed-user';
import { supabaseAdmin } from '@/lib/supabase/admin';

interface CreateMemberBody {
  email: string;
  password: string;
  fullName: string;
  role?: 'agent' | 'viewer';
}

export async function POST(req: Request) {
  try {
    const ctx = await requireRole('admin');

    if (!canManageMembers(ctx.role)) {
      return NextResponse.json(
        { error: 'Only admins can create team members' },
        { status: 403 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Partial<CreateMemberBody>;
    const email = body.email?.trim().toLowerCase();
    const password = body.password;
    const fullName = body.fullName?.trim() || '';
    const role = body.role === 'viewer' ? 'viewer' : 'agent';

    if (!email || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email address is required' },
        { status: 400 },
      );
    }

    if (!password || password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters long' },
        { status: 400 },
      );
    }

    // Check account seat capacity
    const { seatUsage, error: seatErr } = await fetchAccountSeatUsage({
      supabase: ctx.supabase,
      accountId: ctx.accountId,
      maxUsers: ctx.account.max_users,
    });

    if (seatErr || !seatUsage || seatUsage.is_limit_reached) {
      return NextResponse.json(
        {
          error:
            seatErr || !seatUsage
              ? 'Failed to verify account seat capacity'
              : `Account seat limit reached (${seatUsage.max_users} users for ${seatUsage.plan_tier} plan). Please upgrade to add more users.`,
          is_limit_reached: !seatErr && Boolean(seatUsage?.is_limit_reached),
        },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();

    // The one-time database intent carries trusted account/role data into the
    // auth.users INSERT trigger, which locks the account and checks capacity.
    let newUser: Awaited<ReturnType<typeof provisionManagedUser>>;
    try {
      newUser = await provisionManagedUser(admin, {
        email,
        password,
        fullName,
        accountId: ctx.accountId,
        accountRole: role,
        appMetadata: { account_id: ctx.accountId, account_role: role },
      });
    } catch (createErr) {
      return NextResponse.json(
        { error: createErr instanceof Error ? createErr.message : 'Failed to create user' },
        { status: 400 },
      );
    }

    const newUserId = newUser.id;

    return NextResponse.json({
      success: true,
      member: {
        user_id: newUserId,
        full_name: fullName,
        email,
        avatar_url: null,
        role,
        joined_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
