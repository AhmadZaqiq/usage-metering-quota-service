-- Migration: Fix usage_counters user_id sentinel (0 -> NULL)
-- This migration converts the user_id=0 sentinel to NULL for account-level counters
-- and adds partial unique indexes for proper uniqueness.

-- Step 1: Convert existing user_id = 0 to NULL (account-level counters)
UPDATE usage_counters SET user_id = NULL WHERE user_id = 0;

-- Step 2: Make user_id nullable (remove NOT NULL constraint)
ALTER TABLE usage_counters ALTER COLUMN user_id DROP NOT NULL;

-- Step 3: Remove default value
ALTER TABLE usage_counters ALTER COLUMN user_id DROP DEFAULT;

-- Step 4: Drop old unique index (uq_usage_counters_account_user_period)
DROP INDEX IF EXISTS uq_usage_counters_account_user_period;

-- Step 5: Create partial unique indexes
-- Account-level: unique per account per period (user_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_counters_account_period ON usage_counters (account_id, period_start) WHERE user_id IS NULL;

-- User-level: unique per account per user per period
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_counters_user_period ON usage_counters (account_id, user_id, period_start) WHERE user_id IS NOT NULL;

-- Step 6: Add trigger for conditional FK enforcement
-- When user_id IS NOT NULL, enforce FK to users table
CREATE OR REPLACE FUNCTION check_usage_counters_user_id_fk()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id) THEN
            RAISE EXCEPTION 'user_id references non-existent user';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_usage_counters_user_id_fk ON usage_counters;
CREATE TRIGGER trg_check_usage_counters_user_id_fk
BEFORE INSERT OR UPDATE ON usage_counters
FOR EACH ROW EXECUTE FUNCTION check_usage_counters_user_id_fk();