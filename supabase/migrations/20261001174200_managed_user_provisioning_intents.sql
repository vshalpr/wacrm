-- Supabase Auth inserts auth.users before applying Admin API app_metadata.
-- Carry trusted, short-lived provisioning data through a one-use nonce instead.
CREATE TABLE private.managed_user_provisioning_intents (
  email TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE,
  account_role public.account_role_enum,
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (is_platform_admin AND account_id IS NULL AND account_role IS NULL)
    OR (NOT is_platform_admin AND account_id IS NOT NULL AND account_role IS NOT NULL)
  )
);
REVOKE ALL ON private.managed_user_provisioning_intents FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.authorize_managed_user_provisioning(
  p_email TEXT,
  p_nonce TEXT,
  p_account_id UUID DEFAULT NULL,
  p_account_role TEXT DEFAULT NULL,
  p_platform_admin BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_role public.account_role_enum;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR p_email <> lower(btrim(p_email))
    OR p_nonce IS NULL OR length(p_nonce) < 32 THEN
    RAISE EXCEPTION 'Invalid provisioning authorization' USING ERRCODE = '22023';
  END IF;

  IF p_platform_admin THEN
    IF p_account_id IS NOT NULL OR p_account_role IS NOT NULL THEN
      RAISE EXCEPTION 'Platform identity cannot have customer membership' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_account_id IS NULL OR p_account_role IS NULL
      OR p_account_role NOT IN ('owner', 'admin', 'agent', 'viewer') THEN
      RAISE EXCEPTION 'Valid customer and role are required' USING ERRCODE = '22023';
    END IF;
    v_role := p_account_role::public.account_role_enum;
  END IF;

  DELETE FROM private.managed_user_provisioning_intents WHERE expires_at <= now();
  INSERT INTO private.managed_user_provisioning_intents
    (email, nonce, account_id, account_role, is_platform_admin, expires_at)
  VALUES (p_email, p_nonce, p_account_id, v_role, p_platform_admin, now() + interval '5 minutes')
  ON CONFLICT (email) DO UPDATE SET nonce = EXCLUDED.nonce,
    account_id = EXCLUDED.account_id, account_role = EXCLUDED.account_role,
    is_platform_admin = EXCLUDED.is_platform_admin, expires_at = EXCLUDED.expires_at,
    created_at = now();
END;
$$;
ALTER FUNCTION public.authorize_managed_user_provisioning(TEXT, TEXT, UUID, TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_managed_user_provisioning(TEXT, TEXT, UUID, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_managed_user_provisioning(TEXT, TEXT, UUID, TEXT, BOOLEAN)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_managed_user_provisioning(
  p_email TEXT,
  p_nonce TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM private.managed_user_provisioning_intents
    WHERE email = p_email AND nonce = p_nonce;
END;
$$;
ALTER FUNCTION public.cancel_managed_user_provisioning(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cancel_managed_user_provisioning(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_managed_user_provisioning(TEXT, TEXT)
  TO service_role;

-- Use only a matching, unexpired nonce to consume one server-authorized
-- customer or platform intent. User-editable metadata alone grants nothing.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_account_id UUID;
  v_role account_role_enum;
  v_is_platform_admin BOOLEAN;
  v_plan TEXT;
  v_capacity INTEGER;
  v_count INTEGER;
  v_status TEXT;
  v_full_name TEXT;
BEGIN
  DELETE FROM private.managed_user_provisioning_intents
    WHERE email = lower(NEW.email)
      AND nonce = NEW.raw_user_meta_data->>'managed_provisioning_nonce'
      AND expires_at > now()
  RETURNING account_id, account_role, is_platform_admin
    INTO v_account_id, v_role, v_is_platform_admin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Managed customer provisioning required'
      USING ERRCODE = '42501';
  END IF;
  IF v_is_platform_admin THEN RETURN NEW; END IF;

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
