-- ============================================================
-- 043_account_user_limits.sql — Dynamic plan user limits
--
-- Enables user-based plan limits (e.g. 1 user, 5 users, custom).
--
-- 1. Adds `max_users` and `plan_tier` columns to `accounts`.
-- 2. Backfills existing accounts so active teams are not locked out.
-- 3. Adds trigger preventing non-service_role clients from modifying plan limits.
-- 4. Updates `handle_new_user()` so new accounts default to max_users = 1.
-- 5. Updates `redeem_invitation()` with atomic seat limit validation (FOR UPDATE).
-- ============================================================

-- 1. Columns on accounts
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 1 CHECK (max_users > 0),
  ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'starter';

COMMENT ON COLUMN accounts.max_users IS 'Maximum number of active users/members allowed for this account under its subscription plan.';
COMMENT ON COLUMN accounts.plan_tier IS 'Subscription plan name/tier (e.g. starter, team, business, custom).';

-- Backfill existing accounts so teams with multiple members are not locked out
UPDATE accounts a
SET max_users = GREATEST(1, sub.member_count)
FROM (
  SELECT account_id, COUNT(*)::INTEGER AS member_count
  FROM profiles
  GROUP BY account_id
) sub
WHERE a.id = sub.account_id AND a.max_users < sub.member_count;

-- 2. Guard against client-side tampering of plan capacity via PostgREST
CREATE OR REPLACE FUNCTION public.check_account_plan_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (OLD.max_users IS DISTINCT FROM NEW.max_users OR OLD.plan_tier IS DISTINCT FROM NEW.plan_tier) THEN
    -- auth.role() is 'authenticated' or 'anon' for PostgREST user clients.
    -- Only 'service_role' (or superuser/internal migrations where auth.role() IS NULL) can modify.
    IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
      RAISE EXCEPTION 'Modifying plan limits is restricted to service role'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.check_account_plan_immutable() OWNER TO postgres;

DROP TRIGGER IF EXISTS tr_check_account_plan_immutable ON accounts;
CREATE TRIGGER tr_check_account_plan_immutable
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.check_account_plan_immutable();

-- 3. Update handle_new_user() trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id, max_users, plan_tier)
  VALUES (
    COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'),
    NEW.id,
    1,
    'starter'
  )
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- 4. Update redeem_invitation() with seat limit validation
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
  v_current_members INTEGER;
  v_max_users INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Verify target account capacity (seat limit)
  -- FOR UPDATE serializes concurrent redemptions for this account
  SELECT max_users INTO v_max_users
  FROM accounts
  WHERE id = v_inv.account_id
  FOR UPDATE;

  SELECT COUNT(*) INTO v_current_members
  FROM profiles
  WHERE account_id = v_inv.account_id;

  IF v_max_users IS NOT NULL AND v_current_members >= v_max_users THEN
    RAISE EXCEPTION 'This account has reached its user limit (maximum % users)', v_max_users
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
