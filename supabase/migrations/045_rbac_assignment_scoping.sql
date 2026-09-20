-- ============================================================
-- 045_rbac_assignment_scoping.sql
--
-- Enforces data isolation for `agent` and `viewer` roles:
--   - owner / admin  → see and manage ALL rows in their account
--   - agent / viewer → see and manage ONLY rows where assigned_to = auth.uid()
--                      (or assigned_agent_id for conversations;
--                       or profiles.id for deals)
--
-- Implementation:
--   1. New SECURITY DEFINER helper `is_assigned_or_admin()` that
--      encapsulates the combined membership + assignment check.
--      Supports both auth.users(id) (contacts, conversations)
--      and profiles(id) (deals.assigned_to).
--   2. Scopes `_select`, `_update`, and `_delete` policies on
--      `contacts`, `conversations`, and `deals`.
--   3. Parent-join policies on `contact_notes` to scope notes by
--      the parent contact's assignment.
--
-- Child tables (contact_tags, contact_custom_values, messages,
-- message_reactions, flow_run_events) inherit this restriction
-- automatically because their parent-join policies gate through the
-- parent table's now-scoped SELECT.
--
-- Settings-class tables (tags, custom_fields, message_templates,
-- pipelines, automations, flows, whatsapp_config, broadcasts) are
-- NOT scoped by assignment — all account members read them.
-- ============================================================

-- ============================================================
-- HELPER: is_assigned_or_admin
--
-- SECURITY DEFINER so the function body can read `profiles` without
-- triggering recursive RLS evaluation (same pattern as
-- is_account_member from migration 017).
--
-- Returns TRUE iff auth.uid() is a member of target_account_id AND:
--   - their role rank is >= 3 (admin or owner), OR
--   - assigned_user_id = auth.uid() (contacts, conversations), OR
--   - assigned_user_id = p.id (deals.assigned_to FK to profiles.id)
--
-- Note: NULL assigned_user_id → returns FALSE for agent/viewer so
-- that unassigned rows are invisible to them and can only be
-- assigned by admins.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_assigned_or_admin(
  target_account_id UUID,
  assigned_user_id  UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id    = auth.uid()
      AND p.account_id = target_account_id
      AND (
        -- Admin / owner: full visibility
        CASE p.account_role
          WHEN 'owner'  THEN 4
          WHEN 'admin'  THEN 3
          WHEN 'agent'  THEN 2
          WHEN 'viewer' THEN 1
        END >= 3
        OR
        -- Agent / viewer: only rows explicitly assigned to them
        -- Supports auth.users(id) (contacts, conversations) and profiles(id) (deals)
        assigned_user_id = auth.uid()
        OR assigned_user_id = p.id
      )
  );
$$;

ALTER FUNCTION public.is_assigned_or_admin(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_assigned_or_admin(UUID, UUID)
  TO authenticated, service_role;

-- ============================================================
-- CONTACTS — scope SELECT, UPDATE, DELETE to assigned agent / admin
-- ============================================================
DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts
  FOR SELECT USING (
    is_assigned_or_admin(account_id, assigned_to)
  );

DROP POLICY IF EXISTS contacts_update ON contacts;
CREATE POLICY contacts_update ON contacts
  FOR UPDATE USING (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_to)
  )
  WITH CHECK (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_to)
  );

DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts
  FOR DELETE USING (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_to)
  );

-- ============================================================
-- CONVERSATIONS — scope SELECT, UPDATE, DELETE to assigned agent / admin
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations
  FOR SELECT USING (
    is_assigned_or_admin(account_id, assigned_agent_id)
  );

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations
  FOR UPDATE USING (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_agent_id)
  )
  WITH CHECK (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_agent_id)
  );

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations
  FOR DELETE USING (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_agent_id)
  );

-- ============================================================
-- DEALS — scope SELECT, UPDATE, DELETE to assigned agent / admin
-- ============================================================
DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals
  FOR SELECT USING (
    is_assigned_or_admin(account_id, assigned_to)
  );

DROP POLICY IF EXISTS deals_update ON deals;
CREATE POLICY deals_update ON deals
  FOR UPDATE USING (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_to)
  )
  WITH CHECK (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_to)
  );

DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals
  FOR DELETE USING (
    is_account_member(account_id, 'agent') AND is_assigned_or_admin(account_id, assigned_to)
  );

-- ============================================================
-- CONTACT_NOTES — parent-join pattern
-- ============================================================
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
CREATE POLICY contact_notes_select ON contact_notes
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND is_assigned_or_admin(c.account_id, c.assigned_to)
    )
  );

DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
CREATE POLICY contact_notes_update ON contact_notes
  FOR UPDATE USING (
    is_account_member(account_id, 'agent') AND EXISTS (
      SELECT 1
      FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND is_assigned_or_admin(c.account_id, c.assigned_to)
    )
  );

DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;
CREATE POLICY contact_notes_delete ON contact_notes
  FOR DELETE USING (
    is_account_member(account_id, 'agent') AND EXISTS (
      SELECT 1
      FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND is_assigned_or_admin(c.account_id, c.assigned_to)
    )
  );

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_account_assigned_agent
  ON conversations(account_id, assigned_agent_id);

CREATE INDEX IF NOT EXISTS idx_deals_account_assigned_to
  ON deals(account_id, assigned_to);
