import { NextResponse } from "next/server";
import { withPlatformAdmin, invalid, serviceError } from "@/lib/auth/platform-api";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformAdmin(async ({ admin, userId }) => {
    const { id } = await params;
    const body = await request.json().catch(() => null) as { status?: unknown; reason?: unknown } | null;
    if (body?.status !== "active" && body?.status !== "suspended") return invalid("Status must be active or suspended");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : null;
    const { error } = await admin.rpc("platform_update_status", { p_actor: userId, p_account_id: id, p_status: body.status, p_reason: reason || null });
    if (error) return serviceError("platform update status", error);
    return NextResponse.json({ ok: true });
  });
}
