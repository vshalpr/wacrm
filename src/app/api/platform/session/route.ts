import { NextResponse } from "next/server";
import { withPlatformAdmin } from "@/lib/auth/platform-api";

export async function GET() {
  return withPlatformAdmin(async () => NextResponse.json({ ok: true }));
}
