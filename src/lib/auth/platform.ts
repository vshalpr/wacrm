import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";

export interface PlatformAdminContext {
  userId: string;
  admin: ReturnType<typeof supabaseAdmin>;
}

/** Platform access is a separate identity grant, never a customer role. */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();

  const admin = supabaseAdmin();
  const { data, error: lookupError } = await admin
    .from("platform_administrators")
    .select("user_id")
    .eq("user_id", user.id)
    .eq("enabled", true)
    .maybeSingle();
  if (lookupError) {
    console.error("[requirePlatformAdmin] lookup failed:", lookupError.message);
    throw new ForbiddenError("Could not verify platform access");
  }
  if (!data) throw new ForbiddenError("Platform administrator access required");
  return { userId: user.id, admin };
}
