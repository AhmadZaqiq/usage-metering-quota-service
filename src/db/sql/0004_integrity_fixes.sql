-- 0004: integrity fixes from repository audit
-- Idempotent: safe to re-run on every startup after the first application.

-- ---------------------------------------------------------------------------
-- 1) Assignment overlap exclusion constraints (DB-01)
--
-- The legacy constraint used `user_id WITH =`, but PostgreSQL exclusion
-- constraints use strict operators: NULL = NULL evaluates to NULL, not true,
-- so rows with user_id IS NULL (account-level assignments) were never checked
-- and overlapping account-level ranges were silently accepted.
--
-- Fix: two partial exclusion constraints, each with only NOT NULL keys for
-- its subject kind. No sentinel user id is needed, so there is no collision
-- risk with the users.id domain (bigserial, positive).
-- Half-open tstzrange semantics are preserved; zero-width superseded audit
-- rows (effective_to = effective_from) remain empty ranges and never conflict.
-- ---------------------------------------------------------------------------
ALTER TABLE plan_assignments DROP CONSTRAINT IF EXISTS no_overlapping_assignments;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_overlap_account_assignments') THEN
        ALTER TABLE plan_assignments ADD CONSTRAINT no_overlap_account_assignments EXCLUDE USING GIST (
            account_id WITH =,
            tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
        ) WHERE (user_id IS NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_overlap_user_assignments') THEN
        ALTER TABLE plan_assignments ADD CONSTRAINT no_overlap_user_assignments EXCLUDE USING GIST (
            account_id WITH =,
            user_id WITH =,
            tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
        ) WHERE (user_id IS NOT NULL);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Range sanity check (DB-07): reject inverted ranges with 23514 instead
--    of the 22023 range error raised during index expression evaluation.
--    Zero-width ranges stay allowed by design.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_assignment_range') THEN
        ALTER TABLE plan_assignments ADD CONSTRAINT chk_assignment_range
            CHECK (effective_to IS NULL OR effective_to >= effective_from);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Drop the redundant usage_counters FK trigger (DB-06).
--    The real FOREIGN KEY constraint (from the base migration) already
--    enforces the same rule; the trigger only added a users probe to every
--    counter increment. The real FK is kept.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_check_usage_counters_user_id_fk ON usage_counters;
DROP FUNCTION IF EXISTS check_usage_counters_user_id_fk();

-- ---------------------------------------------------------------------------
-- 4) Account name uniqueness for safe bootstrap (CON-02):
--    concurrent bootstraps previously both observed "no account" and inserted
--    duplicates. Unique among live (non-deleted) names only.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_name
    ON accounts (name) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5) Plan name uniqueness must ignore soft-deleted plans (DB-09):
--    a deleted plan previously reserved its name forever.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_system_plans;
DROP INDEX IF EXISTS uq_custom_plans;
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_plans
    ON plans (type, name) WHERE owner_account_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_plans
    ON plans (owner_account_id, type, name) WHERE owner_account_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6) Drop redundant indexes (DB-04): duplicates of primary keys or of the
--    partial unique indexes that already cover the same access paths.
--    uq_users_account_id_id is KEPT: it is the companion unique index for
--    the composite tenant FKs in section 7.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_accounts_active;      -- duplicates accounts_pkey
DROP INDEX IF EXISTS idx_plans_active;         -- duplicates plans_pkey
DROP INDEX IF EXISTS idx_users_account;        -- covered by uq_users_account_client_user prefix
DROP INDEX IF EXISTS idx_usage_counters_lookup;-- covered by uq_usage_counters_{account,user}_period

-- ---------------------------------------------------------------------------
-- 7) Composite tenant foreign keys (DB-10): usage_counters, usage_requests
--    and plan_assignments each store (account_id, user_id). The simple
--    user_id -> users(id) FKs prove the user exists but not that the user
--    belongs to the stated account, so a bug could pair account A's counter
--    with account B's user. The composite FK enforces the pairing in the
--    database. user_id IS NULL (account-level rows) passes via MATCH SIMPLE.
--    uq_users_account_id_id is re-created for databases where an earlier
--    copy of this file dropped it as "redundant".
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_account_id_id ON users (account_id, id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_counters_account_user_fk') THEN
        ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_account_user_fk
            FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id) ON DELETE restrict;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_requests_account_user_fk') THEN
        ALTER TABLE usage_requests ADD CONSTRAINT usage_requests_account_user_fk
            FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id) ON DELETE restrict;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_assignments_account_user_fk') THEN
        ALTER TABLE plan_assignments ADD CONSTRAINT plan_assignments_account_user_fk
            FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id) ON DELETE restrict;
    END IF;
END $$;
