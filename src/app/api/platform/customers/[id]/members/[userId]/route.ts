import { NextResponse } from "next/server";
import { withPlatformAdmin, invalid, serviceError } from "@/lib/auth/platform-api";

type Params = { params: Promise<{ id: string; userId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withPlatformAdmin(async ({ admin, userId: actorId }) => {
    const { id, userId } = await params;
    const body = await request.json().catch(() => null) as { role?: unknown; status?: unknown } | null;
    const update: Record<string, unknown> = {};
    if (body?.role !== undefined) {
    if (!("admin,agent,viewer".split(",") as unknown[]).includes(body.role)) return invalid("Owner changes must use ownership transfer");
      update.account_role = body.role;
    }
    if (body?.status !== undefined) {
      if (body.status !== "active" && body.status !== "disabled") return invalid("Status must be active or disabled");
      update.status = body.status;
    }
    if (!Object.keys(update).length) return invalid("Provide a role or status change");
    const { data: member, error: memberError } = await admin.from("profiles").select("user_id,account_role,status").eq("user_id", userId).eq("account_id", id).maybeSingle();
    if (memberError) return serviceError("platform member lookup", memberError);
    if (!member) return NextResponse.json({ error: "Customer member not found" }, { status: 404 });
    if (member.account_role === "owner" && (update.status === "disabled" || update.account_role)) return invalid("Transfer ownership before changing the owner");
    const { error } = await admin.from("profiles").update(update).eq("user_id", userId).eq("account_id", id);
    if (error) return serviceError("platform member update", error);
    await admin.from("platform_audit_events").insert({ account_id: id, actor_user_id: actorId, action: "member.updated", details: { user_id: userId, before: { role: member.account_role, status: member.status }, after: update } });
    return NextResponse.json({ ok: true });
  });
}
