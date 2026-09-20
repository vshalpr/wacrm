# Code Review: Dynamic Account User Limits & Seat Management

## Overview & Context

This change introduces plan-based dynamic user capacity limits (`max_users` and `plan_tier`) to the workspace accounts system. It includes:
1. Database schema updates in [`supabase/migrations/043_account_user_limits.sql`](file:///D:/relicore-solutions/wacrm/supabase/migrations/043_account_user_limits.sql) adding `max_users` and `plan_tier` columns, and gating `redeem_invitation()` by member count.
2. Server-side seat limit enforcement in [`src/app/api/account/invitations/route.ts`](file:///D:/relicore-solutions/wacrm/src/app/api/account/invitations/route.ts) on invite creation.
3. Seat utilization calculations in [`src/lib/auth/user-limits.ts`](file:///D:/relicore-solutions/wacrm/src/lib/auth/user-limits.ts) exposed via [`src/app/api/account/members/route.ts`](file:///D:/relicore-solutions/wacrm/src/app/api/account/members/route.ts).
4. UI seat usage banner and invite button gating in [`src/components/settings/members-tab.tsx`](file:///D:/relicore-solutions/wacrm/src/components/settings/members-tab.tsx).
5. Localization strings across English, Spanish, Korean, and Portuguese in `messages/*.json`.

---

## Review Checklist & Verdict

| Axis | Initial Status | Resolution Status | Verified Fix |
|---|---|---|---|
| **Security** | ⚠️ **FAIL** | ✅ **PASSED** | Added `check_account_plan_immutable()` BEFORE UPDATE trigger on `accounts` to restrict `max_users` and `plan_tier` edits to service_role |
| **Correctness** | ⚠️ **FAIL** | ✅ **PASSED** | Serialized redemptions with `FOR UPDATE` on `accounts`; mapped check violation `23514` to HTTP 403; backfilled existing multi-member accounts |
| **Architecture** | ⚠️ **NEEDS WORK** | ✅ **PASSED** | Scoped `seatUsage` querying and rendering to admins; consolidated queries into canonical `fetchAccountSeatUsage()` |
| **Readability & Simplicity** | ⚠️ **NEEDS WORK** | ✅ **PASSED** | Cleaned up tooltip conditional wrapper; added ARIA accessibility attributes to progress bar |
| **Performance** | ✅ **PASS (Minor Nit)** | ✅ **PASSED** | Removed redundant `loadEverything()` from member role changes |

### **Final Verdict:** **APPROVED**
All critical, required, and minor issues have been resolved and verified with 1,011 passing automated tests.

---

## Detailed Findings & Resolutions

### 1. Security

#### **Critical:** Unrestricted Client Privilege Escalation on `accounts.max_users` and `accounts.plan_tier` via Supabase RLS
- **File:** [`supabase/migrations/043_account_user_limits.sql`](file:///D:/relicore-solutions/wacrm/supabase/migrations/043_account_user_limits.sql)
- **Problem:** In [`supabase/migrations/017_account_sharing.sql`](file:///D:/relicore-solutions/wacrm/supabase/migrations/017_account_sharing.sql), the RLS policy `accounts_update` grants UPDATE privileges to any user who is an admin or owner (`is_account_member(id, 'admin')`) across all columns. An admin or owner could bypass API routes and update `max_users` or `plan_tier` directly via the browser client:
  ```javascript
  await supabase.from('accounts').update({ max_users: 1000, plan_tier: 'enterprise' }).eq('id', accountId);
  ```
- **Resolution:** Added `check_account_plan_immutable()` trigger function and trigger `tr_check_account_plan_immutable` on `accounts` in [`supabase/migrations/043_account_user_limits.sql`](file:///D:/relicore-solutions/wacrm/supabase/migrations/043_account_user_limits.sql). Changes to `max_users` or `plan_tier` are rejected with `42501` unless performed by `service_role` or internal migrations.

---

### 2. Correctness & Data Integrity

#### **Critical:** Race Condition / Capacity Bypass in `redeem_invitation()`
- **File:** [`supabase/migrations/043_account_user_limits.sql`](file:///D:/relicore-solutions/wacrm/supabase/migrations/043_account_user_limits.sql)
- **Problem:** `redeem_invitation()` locked the invitation row `FOR UPDATE;`, but the target `accounts` row was queried with a non-locking `SELECT`. Concurrent redemptions for the same account could simultaneously pass `v_current_members < v_max_users` before either committed.
- **Resolution:** Added `FOR UPDATE` to the account query:
  ```sql
  SELECT max_users INTO v_max_users
  FROM accounts
  WHERE id = v_inv.account_id
  FOR UPDATE;
  ```
  This serializes concurrent redemptions per account.

#### **Required:** Unhandled Postgres Check Violation (`23514`) Causes HTTP 500 upon Seat Limit Exceeded
- **File:** [`src/app/api/invitations/[token]/redeem/route.ts`](file:///D:/relicore-solutions/wacrm/src/app/api/invitations/%5Btoken%5D/redeem/route.ts)
- **Problem:** `redeem_invitation()` raises `ERRCODE = '23514'` with message `'This account has reached its user limit (maximum % users)'`. `rpcErrorToResponse()` didn't handle `23514`, causing it to log an unexpected error and return generic HTTP 500.
- **Resolution:** Handled `err.code === "23514"` in `rpcErrorToResponse()` returning HTTP 403 with `err.message`.

#### **Required:** Production Migration Risk — Existing Multi-Member Accounts Locked Out
- **File:** [`supabase/migrations/043_account_user_limits.sql`](file:///D:/relicore-solutions/wacrm/supabase/migrations/043_account_user_limits.sql)
- **Problem:** `ALTER TABLE accounts ADD COLUMN ... max_users INTEGER NOT NULL DEFAULT 1` set `max_users = 1` for all existing accounts. Existing collaborative teams would immediately be flagged as over limit.
- **Resolution:** Added an idempotent backfill query:
  ```sql
  UPDATE accounts a
  SET max_users = GREATEST(1, sub.member_count)
  FROM (
    SELECT account_id, COUNT(*)::INTEGER AS member_count
    FROM profiles
    GROUP BY account_id
  ) sub
  WHERE a.id = sub.account_id AND a.max_users < sub.member_count;
  ```

---

### 3. Architecture & Modularity

#### **Required:** Non-Admin Members Receive Inaccurate Seat Metrics Due to RLS
- **File:** [`src/app/api/account/members/route.ts`](file:///D:/relicore-solutions/wacrm/src/app/api/account/members/route.ts) & [`src/components/settings/members-tab.tsx`](file:///D:/relicore-solutions/wacrm/src/components/settings/members-tab.tsx)
- **Problem:** `GET /api/account/members` can be called by non-admins (agents, viewers). Non-admins cannot read `account_invitations` due to RLS, so PostgREST returned count 0, skewing seat calculations.
- **Resolution:**
  1. Gated `seatUsage` computation in `GET /api/account/members` to admin callers (`canManageMembers(ctx.role)`). Non-admins receive `members` without `seatUsage`.
  2. Wrapped the Seat Usage Overview Banner in `<RequireRole min="admin">` in [`members-tab.tsx`](file:///D:/relicore-solutions/wacrm/src/components/settings/members-tab.tsx).

#### **Required:** Inline Calculation Duplication Instead of Using Canonical Helper
- **File:** [`src/app/api/account/invitations/route.ts`](file:///D:/relicore-solutions/wacrm/src/app/api/account/invitations/route.ts) vs [`src/lib/auth/user-limits.ts`](file:///D:/relicore-solutions/wacrm/src/lib/auth/user-limits.ts)
- **Problem:** `POST /api/account/invitations` duplicated the seat calculation inline and copy-pasted the pending invitation count query.
- **Resolution:** Centralized `countPendingInvitations`, `countActiveMembers`, and `fetchAccountSeatUsage` in [`src/lib/auth/user-limits.ts`](file:///D:/relicore-solutions/wacrm/src/lib/auth/user-limits.ts). Refactored both `invitations/route.ts` and `members/route.ts` to consume the helper. Added comprehensive unit tests in [`src/lib/auth/user-limits.test.ts`](file:///D:/relicore-solutions/wacrm/src/lib/auth/user-limits.test.ts).

---

### 4. Readability & Simplicity

#### **Nit:** Tooltip Markup Clarity When Seat Limit Is Not Reached
- **File:** [`src/components/settings/members-tab.tsx`](file:///D:/relicore-solutions/wacrm/src/components/settings/members-tab.tsx)
- **Problem:** `<Tooltip>` wrapped the Invite button unconditionally even when not limit reached, mounting an empty portal on hover.
- **Resolution:** Conditionally rendered `<Tooltip>` only when `isLimitReached && seatUsage`. When limit is not reached, a clean `<Button>` is rendered directly.

#### **Nit:** Progress Bar Lacks Accessible Semantics
- **File:** [`src/components/settings/members-tab.tsx`](file:///D:/relicore-solutions/wacrm/src/components/settings/members-tab.tsx)
- **Problem:** The visual progress bar lacked ARIA attributes.
- **Resolution:** Added `role="progressbar"`, `aria-label={t('seats')}`, `aria-valuenow={seatUsage.total_used}`, `aria-valuemin={0}`, and `aria-valuemax={seatUsage.max_users}`.

---

### 5. Performance

#### **Nit:** Redundant Network Fetch on Member Role Change
- **File:** [`src/components/settings/members-tab.tsx`](file:///D:/relicore-solutions/wacrm/src/components/settings/members-tab.tsx)
- **Problem:** `handleRoleChange` triggered `void loadEverything()`, re-fetching the roster and invitations over the network despite role changes having no effect on seat capacity.
- **Resolution:** Removed `void loadEverything()` from `handleRoleChange`.

---

## Verification Summary

1. **TypeScript Typecheck:** `tsc --noEmit` passed with 0 errors.
2. **ESLint:** Passes with 0 errors in modified files.
3. **Unit & Integration Tests:** Vitest passed 87 test files (1,011 tests passed), including 10 dedicated tests for `user-limits.ts`.
