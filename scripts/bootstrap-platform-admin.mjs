import { createClient } from "@supabase/supabase-js";
import nextEnv from "@next/env";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir);

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.PLATFORM_ADMIN_PASSWORD;
const fullName = process.env.PLATFORM_ADMIN_NAME?.trim() || "Platform administrator";

if (!url || !serviceKey || !email || !password) {
  throw new Error("Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, PLATFORM_ADMIN_EMAIL, and PLATFORM_ADMIN_PASSWORD in the environment or .env.local.");
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const requestUrl = typeof input === "string" ? input : input.url;
      if (response.status >= 500 && requestUrl.includes("/auth/v1/admin/users")) {
        const responseBody = await response.clone().text();
        console.error("Supabase Auth returned a server error while creating the platform identity.");
        if (responseBody) console.error(`Auth response: ${responseBody.slice(0, 1000)}`);
      }
      return response;
    },
  },
});

let user = null;
for (let page = 1; ; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  user = data.users.find((candidate) => candidate.email?.toLowerCase() === email) ?? null;
  if (user || data.users.length < 1000) break;
}

if (user) {
  const { data: profile, error } = await supabase.from("profiles")
    .select("user_id").eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  if (profile) throw new Error("This identity already belongs to a customer. Use a dedicated platform administrator identity.");
} else {
  const nonce = randomBytes(32).toString("hex");
  const { error: authorizationError } = await supabase.rpc("authorize_managed_user_provisioning", {
    p_email: email,
    p_nonce: nonce,
    p_account_id: null,
    p_account_role: null,
    p_platform_admin: true,
  });
  if (authorizationError) throw authorizationError;

  let createdUser;
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, managed_provisioning_nonce: nonce },
    });
    if (error) throw error;
    createdUser = data.user;
    if (!createdUser) throw new Error("Could not create the platform identity.");
  } catch (error) {
    const { error: cancellationError } = await supabase.rpc("cancel_managed_user_provisioning", {
      p_email: email,
      p_nonce: nonce,
    });
    if (cancellationError) {
      console.error("Could not clear the temporary platform bootstrap authorization; it expires in five minutes.");
    }
    if (error?.status >= 500) {
      throw new Error(
        `Supabase Auth could not create the platform identity (HTTP ${error.status}). ` +
        "Check Supabase Logs Explorer for the matching auth_logs and postgres_logs. " +
        "Confirm the managed user provisioning migration is applied to this project. No credentials were printed.",
        { cause: error },
      );
    }
    throw error;
  }
  user = createdUser;

}

if (user.user_metadata?.managed_provisioning_nonce) {
  const userMetadata = { ...user.user_metadata };
  delete userMetadata.managed_provisioning_nonce;
  const { error: metadataError } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: userMetadata,
  });
  if (metadataError) throw metadataError;
}

const { error } = await supabase.from("platform_administrators").upsert(
  { user_id: user.id, enabled: true }, { onConflict: "user_id" },
);
if (error) throw error;
console.log(`Platform administrator enabled for ${email}.`);
