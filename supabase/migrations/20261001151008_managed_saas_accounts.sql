-- Managed SaaS foundations. Existing account ids and CRM foreign keys
-- remain the tenant identifiers; private operational records live in a
-- non-exposed schema.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

ALTER TABLE public.accounts ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'suspended')),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled'));

ALTER TABLE public.automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;
ALTER TABLE public.automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'running', 'paused', 'done', 'failed'));
ALTER TABLE public.broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS paused_from_status TEXT;
ALTER TABLE public.broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'paused'));
ALTER TABLE public.flow_runs DROP CONSTRAINT IF EXISTS flow_runs_status_check;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_status_check CHECK (status IN (
  'active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent',
  'paused_by_platform', 'failed'
));

CREATE TABLE IF NOT EXISTS private.plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seat_mode TEXT NOT NULL CHECK (seat_mode IN ('fixed', 'configurable')),
  fixed_seats INTEGER CHECK (fixed_seats > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((seat_mode = 'fixed' AND fixed_seats IS NOT NULL)
      OR (seat_mode = 'configurable' AND fixed_seats IS NULL))
);
INSERT INTO private.plans (code, name, seat_mode, fixed_seats)
VALUES ('starter', 'Starter', 'fixed', 1), ('team', 'Team', 'configurable', NULL)
ON CONFLICT (code) DO NOTHING;
-- Retain existing custom plan labels as configurable legacy catalog entries.
INSERT INTO private.plans (code, name, seat_mode, fixed_seats)
SELECT DISTINCT plan_tier, initcap(plan_tier), 'configurable', NULL::INTEGER
FROM public.accounts
WHERE plan_tier IS NOT NULL AND plan_tier NOT IN ('starter', 'team')
ON CONFLICT (code) DO NOTHING;
-- Keep Starter only where it already obeys the one-seat rule. Preserve all
-- existing memberships by converting over-capacity Starter accounts to Team.
UPDATE public.accounts a SET plan_tier = 'team',
  max_users = GREATEST(a.max_users, usage.active_users)
FROM (
  SELECT account_id, count(*)::INTEGER AS active_users FROM public.profiles
  WHERE status IS DISTINCT FROM 'disabled' GROUP BY account_id
) usage
WHERE a.id = usage.account_id AND a.plan_tier = 'starter'
  AND (a.max_users <> 1 OR usage.active_users > 1);
UPDATE public.accounts SET max_users = 1 WHERE plan_tier = 'starter' AND max_users <> 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_plan_tier_fkey') THEN
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_plan_tier_fkey
      FOREIGN KEY (plan_tier) REFERENCES private.plans(code);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.platform_customer_details (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  internal_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_commercial_accounts (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  billing_source TEXT NOT NULL DEFAULT 'manual',
  renewal_date DATE,
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_administrators (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_events_account_created_idx
  ON public.platform_audit_events (account_id, created_at DESC);

ALTER TABLE public.platform_customer_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_commercial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_administrators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_customer_details, public.platform_commercial_accounts,
  public.platform_administrators, public.platform_audit_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_customer_details,
  public.platform_commercial_accounts, public.platform_administrators,
  public.platform_audit_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.platform_audit_events_id_seq TO service_role;

-- Several join tables predate account_id. Denormalize their tenant key so
-- server-role writes and foreign references can be checked transactionally.
ALTER TABLE public.contact_tags ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;
UPDATE public.contact_tags ct SET account_id = c.account_id FROM public.contacts c
  WHERE c.id = ct.contact_id AND ct.account_id IS NULL;
ALTER TABLE public.contact_tags ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE public.contact_custom_values ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;
UPDATE public.contact_custom_values cv SET account_id = c.account_id FROM public.contacts c
  WHERE c.id = cv.contact_id AND cv.account_id IS NULL;
ALTER TABLE public.contact_custom_values ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE public.broadcast_recipients ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;
UPDATE public.broadcast_recipients br SET account_id = b.account_id FROM public.broadcasts b
  WHERE b.id = br.broadcast_id AND br.account_id IS NULL;
ALTER TABLE public.broadcast_recipients ALTER COLUMN account_id SET NOT NULL;

-- Profiles are created only by the trusted auth trigger; a user cannot
-- manufacture an unlinked/self-owned profile through PostgREST.
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
REVOKE INSERT ON public.profiles FROM PUBLIC, anon, authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA private TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA private TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA private
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

-- Platform identity is kept out of the customer profile/role system.
CREATE OR REPLACE FUNCTION private.is_platform_admin(p_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_administrators p
    WHERE p.user_id = p_user_id AND p.enabled
  );
$$;
ALTER FUNCTION private.is_platform_admin(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.is_platform_admin(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_platform_admin(UUID) TO service_role;

-- Customer authentication bootstrap accepts only trusted Supabase Admin
-- app_metadata. Public sign-up requests do not control app_metadata.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_account_id UUID;
  v_role account_role_enum;
  v_plan TEXT;
  v_capacity INTEGER;
  v_count INTEGER;
  v_status TEXT;
  v_full_name TEXT;
  v_admin_bootstrap BOOLEAN;
BEGIN
  v_admin_bootstrap := NEW.raw_app_meta_data->>'platform_bootstrap' = 'true';
  IF v_admin_bootstrap THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_account_id := (NEW.raw_app_meta_data->>'account_id')::UUID;
    v_role := (NEW.raw_app_meta_data->>'account_role')::account_role_enum;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Managed customer provisioning required'
      USING ERRCODE = '42501';
  END;
  IF v_account_id IS NULL OR v_role NOT IN ('owner', 'admin', 'agent', 'viewer') THEN
    RAISE EXCEPTION 'Managed customer provisioning required' USING ERRCODE = '42501';
  END IF;

  SELECT plan_tier, max_users, status INTO v_plan, v_capacity, v_status
    FROM public.accounts WHERE id = v_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer account not found' USING ERRCODE = '22023';
  END IF;
  IF v_status <> 'active' AND NOT (v_status = 'pending' AND v_role = 'owner') THEN
    RAISE EXCEPTION 'Customer account is not active' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count FROM public.profiles
    WHERE account_id = v_account_id AND status = 'active';
  IF v_plan = 'starter' AND (v_capacity <> 1 OR v_count >= 1) THEN
    RAISE EXCEPTION 'Starter accounts permit one active user' USING ERRCODE = '23514';
  END IF;
  IF v_count >= v_capacity THEN
    RAISE EXCEPTION 'Customer account has reached its user limit' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'Profile already exists for this identity' USING ERRCODE = '23505';
  END IF;

  v_full_name := COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), '');
  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, status)
    VALUES (NEW.id, v_full_name, NEW.email, v_account_id, v_role, 'active');
  IF v_role = 'owner' THEN
    UPDATE public.accounts SET owner_user_id = NEW.id WHERE id = v_account_id
      AND owner_user_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- Membership and assignment policies now deny disabled profiles and
-- suspended/pending accounts, including for previously issued JWTs.
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
      AND p.status = 'active' AND a.status = 'active'
      AND CASE p.account_role
        WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
      END >= CASE min_role
        WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
      END
  );
$$;
ALTER FUNCTION public.is_account_member(UUID, account_role_enum) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.is_assigned_or_admin(
  target_account_id UUID, assigned_user_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
      AND p.status = 'active' AND a.status = 'active'
      AND (
        CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
          WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END >= 3
        OR assigned_user_id = auth.uid() OR assigned_user_id = p.id
      )
  );
$$;
ALTER FUNCTION public.is_assigned_or_admin(UUID, UUID) OWNER TO postgres;

-- Protect managed entitlement, membership, and lifecycle columns from
-- authenticated PostgREST clients. Service-side admin actions remain audited.
CREATE OR REPLACE FUNCTION private.protect_managed_fields()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- SECURITY DEFINER RPCs run their writes with their trusted owner role
  -- after validating auth.uid() and account authority. Reject direct
  -- PostgREST writes made as authenticated, while allowing those RPCs.
  IF current_user = 'authenticated' THEN
    IF TG_TABLE_NAME = 'profiles' AND (
      NEW.account_id IS DISTINCT FROM OLD.account_id OR
      NEW.account_role IS DISTINCT FROM OLD.account_role
    ) THEN
      RAISE EXCEPTION 'Membership changes require managed provisioning'
        USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'accounts' AND (
      NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW.max_users IS DISTINCT FROM OLD.max_users OR
      NEW.plan_tier IS DISTINCT FROM OLD.plan_tier
    ) THEN
      RAISE EXCEPTION 'Plan and lifecycle changes require managed administration'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.protect_managed_fields() OWNER TO postgres;
DROP TRIGGER IF EXISTS protect_managed_profile_fields ON public.profiles;
CREATE TRIGGER protect_managed_profile_fields BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.protect_managed_fields();
DROP TRIGGER IF EXISTS protect_managed_account_fields ON public.accounts;
CREATE TRIGGER protect_managed_account_fields BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION private.protect_managed_fields();

CREATE OR REPLACE FUNCTION private.enforce_active_seat_limit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_plan TEXT; v_limit INTEGER; v_account_status TEXT; v_used INTEGER;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT plan_tier, max_users, status INTO v_plan, v_limit, v_account_status
    FROM accounts WHERE id = NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer account not found' USING ERRCODE = '23503'; END IF;
  IF v_account_status <> 'active' AND NOT (v_account_status = 'pending' AND NEW.account_role = 'owner') THEN
    RAISE EXCEPTION 'Customer account is not active' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_used FROM profiles
    WHERE account_id = NEW.account_id AND status = 'active'
      AND user_id IS DISTINCT FROM NEW.user_id;
  IF v_plan = 'starter' AND (v_limit <> 1 OR v_used >= 1) THEN
    RAISE EXCEPTION 'Starter accounts permit one active user' USING ERRCODE = '23514';
  END IF;
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Customer account has reached its user limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.enforce_active_seat_limit() OWNER TO postgres;
DROP TRIGGER IF EXISTS enforce_active_profile_seat_limit ON public.profiles;
CREATE TRIGGER enforce_active_profile_seat_limit BEFORE INSERT OR UPDATE OF status, account_id
  ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.enforce_active_seat_limit();

CREATE OR REPLACE FUNCTION private.authorize_member_disable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_caller_role account_role_enum; v_target_role account_role_enum;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  -- Serialize both activation and deactivation with provisioning and
  -- entitlement changes; otherwise usage snapshots can race a seat change.
  PERFORM 1 FROM accounts WHERE id = OLD.account_id FOR UPDATE;
  IF auth.jwt()->>'role' IS NULL OR auth.jwt()->>'role' = 'service_role' THEN RETURN NEW; END IF;
  IF auth.jwt()->>'role' IS DISTINCT FROM 'authenticated' OR auth.uid() = NEW.user_id THEN
    RAISE EXCEPTION 'Member status changes require an authorized customer admin'
      USING ERRCODE = '42501';
  END IF;
  SELECT account_role INTO v_caller_role FROM profiles
    WHERE user_id = auth.uid() AND account_id = OLD.account_id AND status = 'active';
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF OLD.account_role = 'owner' THEN
    RAISE EXCEPTION 'Transfer ownership before disabling the owner' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.authorize_member_disable() OWNER TO postgres;
DROP TRIGGER IF EXISTS authorize_profile_member_disable ON public.profiles;
CREATE TRIGGER authorize_profile_member_disable BEFORE UPDATE OF status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.authorize_member_disable();

CREATE OR REPLACE FUNCTION private.audit_customer_member_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.jwt()->>'role' = 'authenticated' AND (
    NEW.account_role IS DISTINCT FROM OLD.account_role OR
    NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    INSERT INTO platform_audit_events (account_id, actor_user_id, action, details)
      VALUES (NEW.account_id, auth.uid(), 'customer.member_updated', jsonb_build_object(
        'user_id', NEW.user_id,
        'before', jsonb_build_object('role', OLD.account_role, 'status', OLD.status),
        'after', jsonb_build_object('role', NEW.account_role, 'status', NEW.status)
      ));
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.audit_customer_member_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.audit_customer_member_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS audit_customer_member_change ON public.profiles;
CREATE TRIGGER audit_customer_member_change AFTER UPDATE OF account_role, status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.audit_customer_member_change();

-- Revoke old shareable-link redemption. New users are provisioned by a
-- customer/platform admin only; preserve records for audit.
REVOKE EXECUTE ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS account_invitations_select ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_modify ON public.account_invitations;
REVOKE ALL ON public.account_invitations FROM PUBLIC, anon, authenticated;
UPDATE public.account_invitations SET accepted_at = now()
  WHERE accepted_at IS NULL;

-- Preserve the current public-media behavior for the separate media
-- project, while blocking further CRM storage writes for suspended or
-- disabled accounts. Legacy user-only flow-media paths are no longer writable.
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'chat-media' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  ));
DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media" ON storage.objects FOR UPDATE
  USING (bucket_id = 'chat-media' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  ));
DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media" ON storage.objects FOR DELETE
  USING (bucket_id = 'chat-media' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  ));

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'flow-media' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  ));
DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media" ON storage.objects FOR UPDATE
  USING (bucket_id = 'flow-media' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  ));
DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media" ON storage.objects FOR DELETE
  USING (bucket_id = 'flow-media' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  ));

DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
CREATE POLICY "Users can upload their own avatar" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'avatars' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND auth.uid()::text = (storage.foldername(name))[1]
  ));
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
CREATE POLICY "Users can update their own avatar" ON storage.objects FOR UPDATE
  USING (bucket_id = 'avatars' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND auth.uid()::text = (storage.foldername(name))[1]
  ));
DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;
CREATE POLICY "Users can delete their own avatar" ON storage.objects FOR DELETE
  USING (bucket_id = 'avatars' AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid() AND p.status = 'active' AND a.status = 'active'
      AND auth.uid()::text = (storage.foldername(name))[1]
  ));

-- Replace personal-account removal with a reversible deactivation. The
-- target remains assigned to its original tenant and their CRM history.
CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_account_id UUID; v_role account_role_enum; v_target_role account_role_enum;
BEGIN
  SELECT account_id, account_role INTO v_account_id, v_role
    FROM profiles WHERE user_id = auth.uid() AND status = 'active';
  IF v_account_id IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot disable yourself' USING ERRCODE = '22023';
  END IF;
  SELECT account_role INTO v_target_role FROM profiles
    WHERE user_id = p_user_id AND account_id = v_account_id AND status = 'active'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023'; END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Transfer ownership before disabling the owner' USING ERRCODE = '22023';
  END IF;
  UPDATE profiles SET status = 'disabled' WHERE user_id = p_user_id AND account_id = v_account_id;
  RETURN v_account_id;
END;
$$;
ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_member_status(p_user_id UUID, p_status TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_account_id UUID; v_caller_role account_role_enum; v_target_role account_role_enum;
BEGIN
  IF p_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'Invalid member status' USING ERRCODE = '22023';
  END IF;
  SELECT account_id, account_role INTO v_account_id, v_caller_role
    FROM profiles WHERE user_id = auth.uid() AND status = 'active';
  IF v_account_id IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  SELECT account_role INTO v_target_role FROM profiles
    WHERE user_id = p_user_id AND account_id = v_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023'; END IF;
  IF v_target_role = 'owner' AND p_status = 'disabled' THEN
    RAISE EXCEPTION 'Transfer ownership before disabling the owner' USING ERRCODE = '22023';
  END IF;
  UPDATE profiles SET status = p_status WHERE user_id = p_user_id AND account_id = v_account_id;
END;
$$;
ALTER FUNCTION public.set_member_status(UUID,TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_status(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_status(UUID,TEXT) TO authenticated;

-- Platform RPCs run under service_role from requirePlatformAdmin routes.
-- They carry the verified actor for an auditable change record.
CREATE OR REPLACE FUNCTION private.assert_platform_actor(p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (auth.jwt()->>'role' IS DISTINCT FROM 'service_role'
      AND auth.uid() IS DISTINCT FROM p_actor)
     OR NOT private.is_platform_admin(p_actor) THEN
    RAISE EXCEPTION 'Platform administrator access required' USING ERRCODE = '42501';
  END IF;
END;
$$;
ALTER FUNCTION private.assert_platform_actor(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.assert_platform_actor(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.assert_platform_actor(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.platform_create_customer(
  p_actor UUID, p_name TEXT, p_plan TEXT, p_seats INTEGER,
  p_contact_name TEXT, p_contact_email TEXT, p_contact_phone TEXT,
  p_notes TEXT, p_renewal_date DATE
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE v_account_id UUID;
BEGIN
  PERFORM private.assert_platform_actor(p_actor);
  IF length(trim(p_name)) = 0 OR p_plan NOT IN ('starter', 'team') THEN
    RAISE EXCEPTION 'Invalid customer name or plan' USING ERRCODE = '22023';
  END IF;
  IF (p_plan = 'starter' AND p_seats <> 1) OR p_seats < 1 THEN
    RAISE EXCEPTION 'Starter permits exactly one seat; Team requires a positive seat limit'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO accounts (name, owner_user_id, max_users, plan_tier, status)
    VALUES (trim(p_name), NULL, p_seats, p_plan, 'pending')
    RETURNING id INTO v_account_id;
  INSERT INTO platform_customer_details
    (account_id, contact_name, contact_email, contact_phone, internal_notes)
    VALUES (v_account_id, p_contact_name, p_contact_email, p_contact_phone, p_notes);
  INSERT INTO platform_commercial_accounts (account_id, renewal_date)
    VALUES (v_account_id, p_renewal_date);
  INSERT INTO platform_audit_events (account_id, actor_user_id, action)
    VALUES (v_account_id, p_actor, 'customer.created');
  RETURN v_account_id;
END;
$$;
ALTER FUNCTION public.platform_create_customer(UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_create_customer(UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_create_customer(UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.platform_update_customer(
  p_actor UUID, p_account_id UUID, p_name TEXT,
  p_contact_name TEXT, p_contact_email TEXT, p_contact_phone TEXT,
  p_notes TEXT, p_renewal_date DATE
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE v_before JSONB;
BEGIN
  PERFORM private.assert_platform_actor(p_actor);
  SELECT jsonb_build_object(
    'name', a.name, 'contact_name', d.contact_name, 'contact_email', d.contact_email,
    'contact_phone', d.contact_phone, 'internal_notes', d.internal_notes,
    'renewal_date', c.renewal_date
  ) INTO v_before
  FROM accounts a
  LEFT JOIN platform_customer_details d ON d.account_id = a.id
  LEFT JOIN platform_commercial_accounts c ON c.account_id = a.id
  WHERE a.id = p_account_id;
  UPDATE accounts SET name = trim(p_name) WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
  INSERT INTO platform_customer_details
    (account_id, contact_name, contact_email, contact_phone, internal_notes)
    VALUES (p_account_id, p_contact_name, p_contact_email, p_contact_phone, p_notes)
    ON CONFLICT (account_id) DO UPDATE SET
      contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email,
      contact_phone = EXCLUDED.contact_phone, internal_notes = EXCLUDED.internal_notes,
      updated_at = now();
  INSERT INTO platform_commercial_accounts (account_id, renewal_date)
    VALUES (p_account_id, p_renewal_date)
    ON CONFLICT (account_id) DO UPDATE SET renewal_date = EXCLUDED.renewal_date, updated_at = now();
  INSERT INTO platform_audit_events (account_id, actor_user_id, action, details)
    VALUES (p_account_id, p_actor, 'customer.updated', jsonb_build_object(
      'before', v_before,
      'after', jsonb_build_object('name', trim(p_name), 'contact_name', p_contact_name,
        'contact_email', p_contact_email, 'contact_phone', p_contact_phone,
        'internal_notes', p_notes, 'renewal_date', p_renewal_date)
    ));
END;
$$;
ALTER FUNCTION public.platform_update_customer(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_customer(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_customer(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.platform_update_entitlement(
  p_actor UUID, p_account_id UUID, p_plan TEXT, p_seats INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE v_used INTEGER; v_before JSONB;
BEGIN
  PERFORM private.assert_platform_actor(p_actor);
  IF p_plan NOT IN ('starter', 'team') OR p_seats < 1
     OR (p_plan = 'starter' AND p_seats <> 1) THEN
    RAISE EXCEPTION 'Invalid plan or seat limit' USING ERRCODE = '23514';
  END IF;
  SELECT jsonb_build_object('plan', plan_tier, 'seats', max_users) INTO v_before
    FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
  SELECT count(*) INTO v_used FROM profiles WHERE account_id = p_account_id AND status = 'active';
  IF p_seats < v_used THEN
    RAISE EXCEPTION 'Seat limit is below active membership' USING ERRCODE = '23514';
  END IF;
  UPDATE accounts SET plan_tier = p_plan, max_users = p_seats WHERE id = p_account_id;
  INSERT INTO platform_audit_events (account_id, actor_user_id, action, details)
    VALUES (p_account_id, p_actor, 'entitlement.updated',
      jsonb_build_object('before', v_before, 'after', jsonb_build_object('plan', p_plan, 'seats', p_seats)));
END;
$$;
ALTER FUNCTION public.platform_update_entitlement(UUID,UUID,TEXT,INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_entitlement(UUID,UUID,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_entitlement(UUID,UUID,TEXT,INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.platform_update_status(
  p_actor UUID, p_account_id UUID, p_status TEXT, p_reason TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE v_before JSONB;
BEGIN
  PERFORM private.assert_platform_actor(p_actor);
  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Invalid customer status' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object('status', status, 'suspension_reason', suspension_reason)
    INTO v_before FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
  UPDATE accounts SET status = p_status, status_changed_at = now(),
    suspension_reason = CASE WHEN p_status = 'suspended' THEN p_reason ELSE NULL END
    WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
  IF p_status = 'active' AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE account_id = p_account_id
      AND account_role = 'owner' AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'An active owner is required before customer activation'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO platform_audit_events (account_id, actor_user_id, action, details)
    VALUES (p_account_id, p_actor, 'customer.status_changed',
      jsonb_build_object('before', v_before, 'after', jsonb_build_object('status', p_status, 'reason', p_reason)));
  IF p_status = 'suspended' THEN
    UPDATE automation_pending_executions SET status = 'paused'
      WHERE account_id = p_account_id AND status IN ('pending', 'running');
    UPDATE broadcasts SET paused_from_status = status, status = 'paused'
      WHERE account_id = p_account_id AND status IN ('scheduled', 'sending');
    UPDATE flow_runs SET status = 'paused_by_platform', end_reason = 'account_suspended'
      WHERE account_id = p_account_id AND status = 'active';
  END IF;
END;
$$;
ALTER FUNCTION public.platform_update_status(UUID,UUID,TEXT,TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_status(UUID,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_status(UUID,UUID,TEXT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.platform_resume_queued_work(p_actor UUID, p_account_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE v_status TEXT; v_count INTEGER; v_add INTEGER;
BEGIN
  PERFORM private.assert_platform_actor(p_actor);
  SELECT status INTO v_status FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' THEN
    RAISE EXCEPTION 'Reactivate the customer before resuming queued work' USING ERRCODE = '23514';
  END IF;
  UPDATE automation_pending_executions SET status = 'pending'
    WHERE account_id = p_account_id AND status = 'paused';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- Broadcasts remain individually paused. Their customer admin must use
  -- the existing per-campaign resume flow so pending recipients are planned
  -- and actually dispatched only after an explicit campaign-level action.
  UPDATE flow_runs SET status = 'active', end_reason = NULL, last_advanced_at = now()
    WHERE account_id = p_account_id AND status = 'paused_by_platform';
  GET DIAGNOSTICS v_add = ROW_COUNT;
  v_count := v_count + v_add;
  INSERT INTO platform_audit_events (account_id, actor_user_id, action, details)
    VALUES (p_account_id, p_actor, 'customer.queued_work_resumed', jsonb_build_object('count', v_count));
  RETURN v_count;
END;
$$;
ALTER FUNCTION public.platform_resume_queued_work(UUID,UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_resume_queued_work(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_resume_queued_work(UUID,UUID) TO service_role;

-- Service-role routes and workers bypass RLS. Keep denormalized foreign
-- references inside the same customer even on those trusted write paths.
CREATE OR REPLACE FUNCTION private.enforce_same_customer_references()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_account UUID;
BEGIN
  IF TG_TABLE_NAME = 'contact_tags' THEN
    SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
    IF NEW.account_id IS NULL THEN NEW.account_id := v_account; END IF;
    IF v_account IS DISTINCT FROM NEW.account_id OR NOT EXISTS (
      SELECT 1 FROM tags WHERE id = NEW.tag_id AND account_id = NEW.account_id
    ) THEN RAISE EXCEPTION 'Contact tag references must belong to the same customer' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'contact_custom_values' THEN
    SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
    IF NEW.account_id IS NULL THEN NEW.account_id := v_account; END IF;
    IF v_account IS DISTINCT FROM NEW.account_id OR NOT EXISTS (
      SELECT 1 FROM custom_fields WHERE id = NEW.custom_field_id AND account_id = NEW.account_id
    ) THEN RAISE EXCEPTION 'Custom field references must belong to the same customer' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'contact_notes' THEN
    SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
    IF v_account IS DISTINCT FROM NEW.account_id OR NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = NEW.user_id AND account_id = NEW.account_id
    ) THEN RAISE EXCEPTION 'Contact notes must belong to the same customer' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
    IF v_account IS DISTINCT FROM NEW.account_id THEN RAISE EXCEPTION 'Conversation contact must belong to the same customer' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'deals' THEN
    IF NOT EXISTS (SELECT 1 FROM pipelines WHERE id = NEW.pipeline_id AND account_id = NEW.account_id)
       OR NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE id = NEW.stage_id AND pipeline_id = NEW.pipeline_id)
       OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id)
       OR (NEW.conversation_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND account_id = NEW.account_id
       )) THEN RAISE EXCEPTION 'Deal references must belong to the same customer' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'broadcast_recipients' THEN
    SELECT account_id INTO v_account FROM broadcasts WHERE id = NEW.broadcast_id;
    IF NEW.account_id IS NULL THEN NEW.account_id := v_account; END IF;
    IF NOT EXISTS (SELECT 1 FROM broadcasts WHERE id = NEW.broadcast_id AND account_id = NEW.account_id)
       OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id)
    THEN RAISE EXCEPTION 'Broadcast recipients must belong to the same customer' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'flow_runs' THEN
    IF NOT EXISTS (SELECT 1 FROM flows WHERE id = NEW.flow_id AND account_id = NEW.account_id)
       OR (NEW.contact_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id
       ))
       OR (NEW.conversation_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND account_id = NEW.account_id
       )) THEN RAISE EXCEPTION 'Flow run references must belong to the same customer' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.enforce_same_customer_references() OWNER TO postgres;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact_tags','contact_custom_values','contact_notes',
    'conversations','deals','broadcast_recipients','flow_runs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS enforce_customer_references ON public.%I', t);
    EXECUTE format('CREATE TRIGGER enforce_customer_references BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.enforce_same_customer_references()', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION private.enforce_same_customer_references() FROM PUBLIC, anon, authenticated;
