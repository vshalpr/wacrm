import { NextResponse } from "next/server";
import { withPlatformAdmin, invalid, serviceError } from "@/lib/auth/platform-api";
import { provisionManagedUser } from "@/lib/auth/provision-managed-user";

const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim().length <= limit
    ? value.trim() || null
    : null;

export async function GET(request: Request) {
  return withPlatformAdmin(async ({ admin }) => {
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.trim() ?? "";
    const status = url.searchParams.get("status");
    const plan = url.searchParams.get("plan");
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = 25;
    let query = admin.from("accounts")
      .select("id,name,status,plan_tier,max_users,created_at,status_changed_at", { count: "exact" })
      .order("created_at", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (["active", "pending", "suspended"].includes(status ?? "")) query = query.eq("status", status!);
    if (plan && /^[a-z0-9_-]{1,40}$/.test(plan)) query = query.eq("plan_tier", plan);
    if (search) query = query.ilike("name", `%${search.replace(/[%_,]/g, "")}%`);
    const { data, error, count } = await query;
    if (error) return serviceError("platform customers list", error);
    const accounts = data ?? [];
    const ids = accounts.map((account) => account.id);
    const [details, profiles] = await Promise.all([
      ids.length ? admin.from("platform_customer_details").select("account_id,contact_name,contact_email,contact_phone").in("account_id", ids) : Promise.resolve({ data: [], error: null }),
      ids.length ? admin.from("profiles").select("account_id").eq("status", "active").in("account_id", ids) : Promise.resolve({ data: [], error: null }),
    ]);
    if (details.error || profiles.error) return serviceError("platform customers summary", details.error ?? profiles.error!);
    const detailByAccount = new Map((details.data ?? []).map((item) => [item.account_id, item]));
    const seatsByAccount = new Map<string, number>();
    for (const profile of profiles.data ?? []) seatsByAccount.set(profile.account_id, (seatsByAccount.get(profile.account_id) ?? 0) + 1);
    return NextResponse.json({ customers: accounts.map((account) => ({
      ...account,
      details: detailByAccount.get(account.id) ?? null,
      active_users: seatsByAccount.get(account.id) ?? 0,
    })), total: count ?? 0, page, pageSize });
  });
}

export async function POST(request: Request) {
  return withPlatformAdmin(async ({ admin, userId }) => {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)
      return invalid("A customer name of up to 120 characters is required");
    const plan = body.plan === "team" ? "team" : body.plan === "starter" ? "starter" : null;
    const seats = Number(body.seats);
    if (!plan || !Number.isInteger(seats) || seats < 1 || (plan === "starter" && seats !== 1))
      return invalid("Choose Starter with 1 seat or Team with a positive seat limit");
    const ownerEmail = text(body.ownerEmail, 254)?.toLowerCase();
    const ownerPassword = typeof body.ownerPassword === "string" ? body.ownerPassword : "";
    const ownerName = text(body.ownerName, 120);
    if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || ownerPassword.length < 8 || !ownerName)
      return invalid("Initial owner name, valid email, and password of at least 8 characters are required");
    const date = body.renewalDate ? text(body.renewalDate, 10) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid("Renewal date must use YYYY-MM-DD");

    const { data: accountId, error } = await admin.rpc("platform_create_customer", {
      p_actor: userId, p_name: body.name.trim(), p_plan: plan, p_seats: seats,
      p_contact_name: text(body.contactName, 120), p_contact_email: text(body.contactEmail, 254),
      p_contact_phone: text(body.contactPhone, 50), p_notes: text(body.notes, 4000), p_renewal_date: date,
    });
    if (error || !accountId) return serviceError("platform create customer", error ?? { message: "Missing account id" });

    let ownerUser: Awaited<ReturnType<typeof provisionManagedUser>>;
    try {
      ownerUser = await provisionManagedUser(admin, {
        email: ownerEmail, password: ownerPassword, fullName: ownerName,
        accountId, accountRole: "owner",
        appMetadata: { account_id: accountId, account_role: "owner" },
      });
    } catch (createError) {
      return NextResponse.json({ error: createError instanceof Error ? createError.message : "Initial owner provisioning failed", customerId: accountId, status: "pending" }, { status: 409 });
    }

    await admin.from("platform_audit_events").insert({
      account_id: accountId, actor_user_id: userId, action: "customer.owner_provisioned",
      details: { user_id: ownerUser.id, role: "owner", email: ownerEmail },
    });

    const { error: activateError } = await admin.rpc("platform_update_status", {
      p_actor: userId, p_account_id: accountId, p_status: "active", p_reason: null,
    });
    if (activateError) {
      return NextResponse.json({ error: "Customer and owner were created but activation failed; retry activation from the customer page", customerId: accountId, status: "pending" }, { status: 500 });
    }
    return NextResponse.json({ customerId: accountId, status: "active" }, { status: 201 });
  });
}
