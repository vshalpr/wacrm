import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthUser } from "@supabase/supabase-js";
import type { AccountRole } from "./roles";

interface ProvisionManagedUserInput {
  email: string;
  password: string;
  fullName: string;
  accountId?: string;
  accountRole?: AccountRole;
  platformAdmin?: boolean;
  appMetadata?: Record<string, unknown>;
}

function hasAmbiguousAuthResult(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; status?: unknown };
  return candidate.name === "AuthRetryableFetchError" ||
    (typeof candidate.status === "number" && (candidate.status === 0 || candidate.status >= 500));
}

async function cancelProvisioningIntent(
  admin: SupabaseClient,
  email: string,
  nonce: string,
): Promise<void> {
  try {
    const { error } = await admin.rpc("cancel_managed_user_provisioning", {
      p_email: email,
      p_nonce: nonce,
    });
    if (error) throw error;
  } catch {
    console.error("Failed to clear an unused managed-user provisioning intent; it expires in five minutes.");
  }
}

async function reconcileCreatedUser(
  admin: SupabaseClient,
  email: string,
  accountId: string | undefined,
  accountRole: AccountRole | undefined,
): Promise<AuthUser | null> {
  // This path is only used after a retryable/5xx Auth result. Never call
  // createUser again: first determine whether Auth committed the recipient.
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) {
      if (!accountId || !accountRole) return null;
      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("account_id, account_role, status")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      return profile?.account_id === accountId &&
        profile.account_role === accountRole &&
        profile.status === "active"
        ? user
        : null;
    }
    if (data.users.length < 1000) return null;
  }
}

/**
 * Authorize an Auth INSERT with a short-lived nonce that the database trigger
 * consumes. Supabase applies app_metadata after the INSERT trigger has fired,
 * so it cannot safely carry the trigger's initial provisioning authority.
 */
export async function provisionManagedUser(
  admin: SupabaseClient,
  input: ProvisionManagedUserInput,
): Promise<AuthUser> {
  const nonce = randomBytes(32).toString("hex");
  const email = input.email.trim().toLowerCase();
  const platformAdmin = input.platformAdmin ?? false;
  const { error: intentError } = await admin.rpc("authorize_managed_user_provisioning", {
    p_email: email,
    p_nonce: nonce,
    p_account_id: input.accountId ?? null,
    p_account_role: input.accountRole ?? null,
    p_platform_admin: platformAdmin,
  });
  if (intentError) throw intentError;

  let user: AuthUser;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName, managed_provisioning_nonce: nonce },
      app_metadata: input.appMetadata,
    });
    if (error) throw error;
    if (!data.user) throw new Error("Supabase Auth returned no user after provisioning.");
    user = data.user;
  } catch (error) {
    if (hasAmbiguousAuthResult(error)) {
      let existingUser: AuthUser | null = null;
      try {
        existingUser = await reconcileCreatedUser(
          admin,
          email,
          input.accountId,
          input.accountRole,
        );
      } catch {
        await cancelProvisioningIntent(admin, email, nonce);
        console.error("Could not reconcile an ambiguous managed-user Auth response.");
        throw error;
      }
      if (!existingUser) {
        await cancelProvisioningIntent(admin, email, nonce);
        throw error;
      }
      user = existingUser;
    } else {
      await cancelProvisioningIntent(admin, email, nonce);
      throw error;
    }
  }

  const userMetadata = { ...user.user_metadata };
  delete userMetadata.managed_provisioning_nonce;
  const { error: metadataError } = await admin.auth.admin.updateUserById(user.id, {
    user_metadata: userMetadata,
  });
  if (metadataError) {
    // The intent has already been consumed, so this nonce grants no authority.
    console.error("A consumed managed-user provisioning nonce could not be removed from user metadata.");
  }

  return user;
}
