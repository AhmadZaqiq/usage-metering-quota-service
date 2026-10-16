-- Add account_remaining and user_remaining columns to usage_requests
-- These store the quota remaining at the time of the request for idempotent retries

ALTER TABLE usage_requests
ADD COLUMN IF NOT EXISTS account_remaining BIGINT,
ADD COLUMN IF NOT EXISTS user_remaining BIGINT;

-- Backfill existing records with 0 (they won't be used for idempotent retries anyway)
UPDATE usage_requests
SET account_remaining = 0,
    user_remaining = 0
WHERE account_remaining IS NULL;