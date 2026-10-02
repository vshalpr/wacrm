import { NextResponse } from "next/server";
import { withPlatformAdmin, invalid, serviceError } from "@/lib/auth/platform-api";
import { provisionManagedUser } from "@/lib/auth/provision-managed-user";
import type { AccountRole } from "@/lib/auth/roles";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformAdmin(async ({ admin }) => {
    const { id } = await params;
    const { data, error } = await admin.from("profiles")
      .select("user_id,full_name,email,account_role,status,created_at")
      .eq("account_id", id).order("created_at");
    if (error) return serviceError("platform customer members", error);
    return NextResponse.json({ members: data ?? [] });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformAdmin(async ({ admin, userId }) => {
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";
    const role = body?.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName || fullName.length > 120 || password.length < 8)
      return invalid("Valid email, name, and password of at least 8 characters are required");
    if (!(["owner", "admin", "agent", "viewer"] as unknown[]).includes(role)) return invalid("Choose a valid customer role");
    const { data: account, error: accountError } = await admin.from("accounts").select("status,owner_user_id,max_users,plan_tier").eq("id", id).maybeSingle();
    if (accountError) return serviceError("platform member account", accountError);
    if (!account) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    if (account.status !== "active" && !(account.status === "pending" && role === "owner" && !account.owner_user_id))
      return NextResponse.json({ error: "Customer is not accepting users" }, { status: 409 });
    if (role === "owner" && account.owner_user_id) return invalid("Transfer ownership to an existing customer member");
    const { count: activeUsers, error: countError } = await admin.from("profiles")
      .select("user_id", { count: "exact", head: true }).eq("account_id", id).eq("status", "active");
    if (countError) return serviceError("platform customer seat count", countError);
    if ((activeUsers ?? 0) >= account.max_users || (account.plan_tier === "starter" && (activeUsers ?? 0) >= 1))
      return NextResponse.json({ error: `Customer seat limit reached (${account.max_users} seats)` }, { status: 409 });

    let createdUser: Awaited<ReturnType<typeof provisionManagedUser>>;
    try {
      createdUser = await provisionManagedUser(admin, {
        email, password, fullName, accountId: id, accountRole: role as AccountRole,
        appMetadata: { account_id: id, account_role: role },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "User provisioning failed";
      const status = /user limit|seat|capacity|Starter/i.test(message) ? 409 : 400;
      return NextResponse.json({ error: message }, { status });
    }
    await admin.from("platform_audit_events").insert({
      account_id: id, actor_user_id: userId, action: role === "owner" ? "customer.owner_provisioned" : "member.created",
      details: { user_id: createdUser.id, role, email },
    });
    return NextResponse.json({ userId: createdUser.id, email, fullName, role, status: "active" }, { status: 201 });
  });
}
