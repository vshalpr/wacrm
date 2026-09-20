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
    const password = body.password?.trim();
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

    // Create user in Supabase auth with protected app_metadata pointing to this account
    const { data: userData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
      },
      app_metadata: {
        account_id: ctx.accountId,
        account_role: role,
      },
    });

    if (createErr || !userData.user) {
      return NextResponse.json(
        { error: createErr?.message || 'Failed to create user' },
        { status: 400 },
      );
    }

    const newUserId = userData.user.id;

    // Ensure profile row exists and is linked to caller's account
    const { error: profileErr } = await admin.from('profiles').upsert(
      {
        user_id: newUserId,
        full_name: fullName,
        email,
        account_id: ctx.accountId,
        account_role: role,
      },
      { onConflict: 'user_id' },
    );

    if (profileErr) {
      console.error('[POST /api/account/members/create] profile error:', profileErr);
      // Rollback newly created auth user so we do not leave orphaned credentials
      await admin.auth.admin.deleteUser(newUserId).catch((delErr) => {
        console.error('[POST /api/account/members/create] rollback deleteUser error:', delErr);
      });
      return NextResponse.json(
        { error: 'Failed to create member profile' },
        { status: 500 },
      );
    }

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
