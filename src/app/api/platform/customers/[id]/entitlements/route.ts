import { NextResponse } from "next/server";
import { withPlatformAdmin, invalid, serviceError } from "@/lib/auth/platform-api";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformAdmin(async ({ admin, userId }) => {
    const { id } = await params;
    const body = await request.json().catch(() => null) as { plan?: unknown; seats?: unknown } | null;
    const plan = body?.plan;
    const seats = body?.seats;
    if ((plan !== "starter" && plan !== "team") || !Number.isInteger(seats) || Number(seats) < 1 || (plan === "starter" && seats !== 1))
      return invalid("Starter requires exactly one seat; Team requires a positive seat limit");
    const { error } = await admin.rpc("platform_update_entitlement", { p_actor: userId, p_account_id: id, p_plan: plan, p_seats: seats });
    if (error) return serviceError("platform update entitlement", error);
    return NextResponse.json({ ok: true });
  });
}
