-- Enable btree_gist extension for exclusion constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Check constraints for plans (only if not exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plan_type') THEN
        ALTER TABLE plans ADD CONSTRAINT chk_plan_type CHECK (type IN ('account', 'user'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plan_allowance_positive') THEN
        ALTER TABLE plans ADD CONSTRAINT chk_plan_allowance_positive CHECK (monthly_allowance > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plan_max_units_positive') THEN
        ALTER TABLE plans ADD CONSTRAINT chk_plan_max_units_positive CHECK (max_units_per_request > 0);
    END IF;
END $$;

-- Check constraint for usage_counters
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_counter_non_negative') THEN
        ALTER TABLE usage_counters ADD CONSTRAINT chk_counter_non_negative CHECK (counter >= 0);
    END IF;
END $$;

-- Check constraints for usage_requests
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_usage_request_units_positive') THEN
        ALTER TABLE usage_requests ADD CONSTRAINT chk_usage_request_units_positive CHECK (units > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_usage_request_decision') THEN
        ALTER TABLE usage_requests ADD CONSTRAINT chk_usage_request_decision CHECK (decision IN ('accepted', 'rejected'));
    END IF;
END $$;

-- Partial unique indexes for plans (system vs custom)
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_plans ON plans (type, name) WHERE owner_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_plans ON plans (owner_account_id, type, name) WHERE owner_account_id IS NOT NULL;

-- Partial unique indexes for current assignments
CREATE UNIQUE INDEX IF NOT EXISTS uq_current_account_assignment ON plan_assignments (account_id) WHERE user_id IS NULL AND effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_current_user_assignment ON plan_assignments (user_id) WHERE user_id IS NOT NULL AND effective_to IS NULL;

-- Partial index for active API keys
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys (prefix) WHERE NOT is_revoked;

-- Exclusion constraint for overlapping assignments
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_overlapping_assignments') THEN
        ALTER TABLE plan_assignments ADD CONSTRAINT no_overlapping_assignments EXCLUDE USING GIST (
            account_id WITH =,
            user_id WITH =,
            tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
        );
    END IF;
END $$;

-- Trigger function for plan-type compatibility
CREATE OR REPLACE FUNCTION check_plan_type_matches()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        -- Account-level assignment requires account plan
        IF (SELECT type FROM plans WHERE id = NEW.plan_id) <> 'account' THEN
            RAISE EXCEPTION 'Account-level assignment requires account plan';
        END IF;
    ELSE
        -- User-level assignment requires user plan
        IF (SELECT type FROM plans WHERE id = NEW.plan_id) <> 'user' THEN
            RAISE EXCEPTION 'User-level assignment requires user plan';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on plan_assignments
DROP TRIGGER IF EXISTS trg_check_plan_type_matches ON plan_assignments;
CREATE TRIGGER trg_check_plan_type_matches
BEFORE INSERT OR UPDATE ON plan_assignments
FOR EACH ROW EXECUTE FUNCTION check_plan_type_matches();