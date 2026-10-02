import { NextResponse } from "next/server";
import { withPlatformAdmin, serviceError } from "@/lib/auth/platform-api";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformAdmin(async ({ admin, userId }) => {
    const { id } = await params;
    const { data, error } = await admin.rpc("platform_resume_queued_work", {
      p_actor: userId,
      p_account_id: id,
    });
    if (error) return serviceError("resume queued work", error);
    return NextResponse.json({ ok: true, resumed: data });
  });
}
