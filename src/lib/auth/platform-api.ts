import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { toErrorResponse } from "@/lib/auth/account";

export async function withPlatformAdmin(
  handler: (
    ctx: Awaited<ReturnType<typeof requirePlatformAdmin>>,
  ) => Promise<Response>,
) {
  try {
    return await handler(await requirePlatformAdmin());
  } catch (error) {
    return toErrorResponse(error);
  }
}

export function invalid(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

export function serviceError(context: string, error: { code?: string; message?: string }) {
  if (error.code === "23514" || error.code === "22023") {
    return conflict(error.message || "The requested change conflicts with customer state");
  }
  console.error(`[${context}]`, error.message);
  return NextResponse.json({ error: "The customer operation failed" }, { status: 500 });
}
