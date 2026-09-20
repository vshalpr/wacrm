-- ============================================================
-- 044_contact_assignment_and_team_isolation.sql
--
-- 1. Adds `assigned_to` on `contacts` to allow admins to assign
--    contacts to team members (agents).
-- 2. Updates `handle_new_user()` so if a user is provisioned with
--    an `account_id` in metadata (e.g. created by admin), they are
--    attached directly to the admin's account and DO NOT get their
--    own team created.
-- 3. Syncs contact assignment with `conversations.assigned_agent_id`
--    so assigning a contact automatically routes the conversation
--    to that agent for chat management.
-- ============================================================

-- 1. Add assigned_to to contacts
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_account_assigned_to
  ON contacts(account_id, assigned_to);

-- 2. Update handle_new_user() trigger to support direct team member provisioning
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  -- Check if user was created directly into an existing team/account via service-role app_metadata
  -- (raw_app_meta_data is protected by Supabase; normal client signUp cannot set it).
  IF NEW.raw_app_meta_data->>'account_id' IS NOT NULL THEN
    BEGIN
      v_target_account_id := (NEW.raw_app_meta_data->>'account_id')::UUID;
      v_target_role := COALESCE(NEW.raw_app_meta_data->>'account_role', 'agent')::account_role_enum;
    EXCEPTION WHEN OTHERS THEN
      v_target_account_id := NULL;
    END;

    -- Verify the account actually exists before attaching
    IF v_target_account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.accounts WHERE id = v_target_account_id
    ) THEN
      v_target_account_id := NULL;
    END IF;
  END IF;

  IF v_target_account_id IS NOT NULL THEN
    -- User joins existing account directly as assigned role (default 'agent')
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_target_account_id, v_target_role)
    ON CONFLICT (user_id) DO UPDATE
      SET account_id = EXCLUDED.account_id,
          account_role = EXCLUDED.account_role,
          full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name);
    RETURN NEW;
  END IF;

  -- Default: bootstrap a fresh personal account (only for regular signups)
  INSERT INTO public.accounts (name, owner_user_id, max_users, plan_tier)
  VALUES (
    COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'),
    NEW.id,
    1,
    'starter'
  )
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner')
  ON CONFLICT (user_id) DO UPDATE
    SET account_id = EXCLUDED.account_id,
        account_role = EXCLUDED.account_role,
        full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- 3. Automatic sync of contact assignment to linked conversations
CREATE OR REPLACE FUNCTION public.sync_contact_assignment_to_conversations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.assigned_to IS NOT NULL) OR
     (TG_OP = 'UPDATE' AND NEW.assigned_to IS DISTINCT FROM OLD.assigned_to) THEN
    UPDATE conversations
    SET assigned_agent_id = NEW.assigned_to
    WHERE contact_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_contact_assignment_to_conversations() OWNER TO postgres;

DROP TRIGGER IF EXISTS tr_sync_contact_assignment ON contacts;
CREATE TRIGGER tr_sync_contact_assignment
  AFTER INSERT OR UPDATE OF assigned_to ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_contact_assignment_to_conversations();

-- 4. Set default assignee on new conversations based on contact assignment
CREATE OR REPLACE FUNCTION public.set_conversation_default_assignee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL AND NEW.contact_id IS NOT NULL THEN
    SELECT assigned_to INTO NEW.assigned_agent_id
    FROM contacts
    WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.set_conversation_default_assignee() OWNER TO postgres;

DROP TRIGGER IF EXISTS tr_conversation_default_assignee ON conversations;
CREATE TRIGGER tr_conversation_default_assignee
  BEFORE INSERT ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_conversation_default_assignee();

-- 5. Update filter_contacts_by_tags to support assignee filtering
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID);
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_assigned_to UUID DEFAULT NULL,
  p_unassigned_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        (p_unassigned_only AND c.assigned_to IS NULL)
        OR (NOT p_unassigned_only AND (p_assigned_to IS NULL OR c.assigned_to = p_assigned_to))
      )
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID, BOOLEAN) TO authenticated;

