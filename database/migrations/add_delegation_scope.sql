-- ====================================================================
-- Migration: Scope approval delegations to specific requests
-- ====================================================================
-- Before this change every delegation was BLANKET: any approval that
-- landed on the delegator during the window was auto-routed to the
-- delegate, and the "redirect these in-flight requests" checklist only
-- moved *additional* already-started requests. Admins reasonably read
-- that checklist as "delegate ONLY these", so requests they never
-- intended to hand over were silently signed by the delegate.
--
-- A delegation now carries an explicit scope:
--   'all'      — every approval for the delegator in the window (old behaviour)
--   'specific' — only approvals on the requests listed in request_ids
--
-- Existing rows are backfilled to 'all' so historical records keep
-- describing what actually happened.
-- ====================================================================

BEGIN;

ALTER TABLE approval_delegations
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'all',
    ADD COLUMN IF NOT EXISTS request_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];

-- Only the two known scopes, and a 'specific' delegation must actually
-- name at least one request (otherwise it would silently delegate nothing).
ALTER TABLE approval_delegations
    DROP CONSTRAINT IF EXISTS approval_delegations_scope_valid;
ALTER TABLE approval_delegations
    ADD CONSTRAINT approval_delegations_scope_valid CHECK (
        (scope = 'all')
        OR (scope = 'specific' AND COALESCE(array_length(request_ids, 1), 0) > 0)
    );

-- Membership lookups on request_ids are the hot path in getActiveDelegateFor().
CREATE INDEX IF NOT EXISTS idx_approval_delegations_request_ids
    ON approval_delegations USING GIN (request_ids);

COMMENT ON COLUMN approval_delegations.scope IS
    '''all'' = every approval for the delegator during the window; ''specific'' = only the requests in request_ids.';
COMMENT ON COLUMN approval_delegations.request_ids IS
    'When scope = ''specific'', the exact requests this delegation covers.';

COMMIT;
