import { NextResponse } from "next/server";
import { withPlatformAdmin, invalid, serviceError } from "@/lib/auth/platform-api";

type Params = { params: Promise<{ id: string }> };
const nullableText = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim().length <= limit ? value.trim() || null : null;

export async function GET(_request: Request, { params }: Params) {
  return withPlatformAdmin(async ({ admin }) => {
    const { id } = await params;
    const [account, details, commercial, members, events] = await Promise.all([
      admin.from("accounts").select("id,name,status,plan_tier,max_users,created_at,status_changed_at,suspension_reason").eq("id", id).maybeSingle(),
      admin.from("platform_customer_details").select("*").eq("account_id", id).maybeSingle(),
      admin.from("platform_commercial_accounts").select("renewal_date,billing_source").eq("account_id", id).maybeSingle(),
      admin.from("profiles").select("user_id,full_name,email,account_role,status,created_at").eq("account_id", id).order("created_at"),
      admin.from("platform_audit_events").select("id,actor_user_id,action,details,created_at").eq("account_id", id).order("created_at", { ascending: false }).limit(50),
    ]);
    if (account.error || details.error || commercial.error || members.error || events.error)
      return serviceError("platform customer detail", account.error ?? details.error ?? commercial.error ?? members.error ?? events.error!);
    if (!account.data) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    return NextResponse.json({ customer: { ...account.data, details: details.data, commercial: commercial.data }, members: members.data ?? [], events: events.data ?? [] });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withPlatformAdmin(async ({ admin, userId }) => {
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)
      return invalid("Customer name of up to 120 characters is required");
    const date = body.renewalDate ? nullableText(body.renewalDate, 10) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid("Renewal date must use YYYY-MM-DD");
    const { error } = await admin.rpc("platform_update_customer", {
      p_actor: userId, p_account_id: id, p_name: body.name.trim(),
      p_contact_name: nullableText(body.contactName, 120),
      p_contact_email: nullableText(body.contactEmail, 254),
      p_contact_phone: nullableText(body.contactPhone, 50),
      p_notes: nullableText(body.notes, 4000), p_renewal_date: date,
    });
    if (error) return serviceError("platform update customer", error);
    return NextResponse.json({ ok: true });
  });
}
