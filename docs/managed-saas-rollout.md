# Managed SaaS onboarding rollout

This release disables public account creation and enables managed customer
provisioning. Apply the migration to a staging database first and inspect the
resulting customer/user counts before production rollout.

## Hosted Supabase Auth

The hosted Auth project is configured in the Supabase Dashboard and is not
controlled by `supabase/config.toml`. Before release, turn off **Allow new users
to sign up** under Authentication settings. Existing users can still log in
and use password recovery. The database `auth.users` trigger independently
rejects identities without a short-lived, one-time server-side provisioning
intent. This intent carries the trusted account and role because Supabase
applies Admin API `app_metadata` after the initial `auth.users` insert.

## Bootstrap a platform administrator

Use an operator-controlled environment and a dedicated address. The script
loads the repository's `.env.local` automatically. The Supabase URL can be
named `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`. It also requires
`SUPABASE_SERVICE_ROLE_KEY`, `PLATFORM_ADMIN_EMAIL`, and
`PLATFORM_ADMIN_PASSWORD`; `PLATFORM_ADMIN_NAME` is optional.
Keep the service-role key and initial password in a secret manager; never put
them in shell history, tickets, or logs.

```powershell
node scripts/bootstrap-platform-admin.mjs
```

Apply the managed user provisioning intent migration before running the
script. It creates a random one-time nonce, authorizes it through a
service-role-only RPC, and removes it from user metadata immediately after
Auth creation. The same service is used for customer member and owner creation.

The resulting identity has no customer profile. Platform administrator access
is controlled by the private administrator table, not editable user metadata.
Provision additional platform administrators through the same operator-only
process after review.

## Verification before production

1. Back up the database and rehearse the migration against a recent copy.
2. Review orphan identities, accounts without owners, disabled/duplicate
   memberships, and cross-customer references before rollout. Do not delete or
   merge records automatically.
3. Verify account IDs, CRM row counts, custom plans, and customer data remain
   intact. Starter customers with more than one existing active member are
   upgraded to Team with capacity sufficient for their current members.
4. Confirm ordinary `auth.signUp()` and direct Auth API registration fail,
   while login and password recovery continue to work.
5. Confirm a platform admin can create a pending customer, provision its owner,
   activate it, and create users only up to its configured seat limit.
6. Confirm a customer admin can manage members inside their own account and
   cannot reach `/platform` or another customer's data.
7. Suspend a test customer and confirm existing sessions, API keys, CRM APIs,
   storage writes, and outbound jobs are denied. Verify inbound messages and
   delivery receipts are still recorded. After reactivation, queued work stays
   paused until an administrator explicitly resumes it.
8. Verify hosted callback URLs and password reset behavior in the deployment
   environment.

Run this read-only cross-customer reference report before applying the
tenant-integrity triggers. Every count should be zero; investigate and repair
each record with an audited, customer-approved data correction rather than
silently reassigning it:

```sql
SELECT 'contact_tags' AS relation, count(*) AS mismatches
FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id
JOIN tags t ON t.id = ct.tag_id WHERE c.account_id <> t.account_id
UNION ALL
SELECT 'contact_custom_values', count(*) FROM contact_custom_values cv
JOIN contacts c ON c.id = cv.contact_id JOIN custom_fields f ON f.id = cv.custom_field_id
WHERE c.account_id <> f.account_id
UNION ALL
SELECT 'contact_notes', count(*) FROM contact_notes n
JOIN contacts c ON c.id = n.contact_id JOIN profiles p ON p.user_id = n.user_id
WHERE c.account_id <> p.account_id
UNION ALL
SELECT 'conversations', count(*) FROM conversations cv
JOIN contacts c ON c.id = cv.contact_id WHERE cv.account_id <> c.account_id
UNION ALL
SELECT 'deals', count(*) FROM deals d
JOIN pipelines p ON p.id = d.pipeline_id
JOIN pipeline_stages s ON s.id = d.stage_id
JOIN contacts c ON c.id = d.contact_id
LEFT JOIN conversations cv ON cv.id = d.conversation_id
WHERE d.account_id <> p.account_id OR d.account_id <> c.account_id
   OR s.pipeline_id <> d.pipeline_id OR (cv.id IS NOT NULL AND d.account_id <> cv.account_id)
UNION ALL
SELECT 'broadcast_recipients', count(*) FROM broadcast_recipients br
JOIN broadcasts b ON b.id = br.broadcast_id JOIN contacts c ON c.id = br.contact_id
WHERE b.account_id <> c.account_id
UNION ALL
SELECT 'flow_runs', count(*) FROM flow_runs r
JOIN flows f ON f.id = r.flow_id
LEFT JOIN contacts c ON c.id = r.contact_id
LEFT JOIN conversations cv ON cv.id = r.conversation_id
WHERE r.account_id <> f.account_id OR (c.id IS NOT NULL AND r.account_id <> c.account_id)
   OR (cv.id IS NOT NULL AND r.account_id <> cv.account_id);
```

## Rollback

Do not restore public signup as a rollback. Keep registration closed and
security protections enabled while reverting application code. The migration
is additive and preserves customer/CRM records; coordinate any schema rollback
as a forward repair after reviewing the affected data. Public media buckets
remain unchanged by this release and require the separate private-media
migration project.
