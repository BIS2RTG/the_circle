-- ====================================================================
-- Migration: assistant gatekeeping (screen approvals before the boss)
-- ====================================================================
-- Iteration 3 of assistant assignments. A new capability lets an
-- assistant SCREEN a principal's incoming approvals before they reach
-- the principal (the "boss"):
--   can_gatekeep — receive the approval notification/email FIRST, then
--                  either forward it to the boss or return it to the
--                  requestor with a comment for changes.
--
-- When an approval step activates for a boss who has one or more
-- gatekeeping assistants, the step is parked in a "pending_screen"
-- state and the gatekeeper(s) are notified instead of the boss. The
-- first gatekeeper to act resolves the screen:
--   forward  -> step returns to the normal pending flow, boss notified
--   return   -> request goes back to the requestor's Drafts with a note
--
-- These columns are all nullable / default-safe so existing rows and
-- the non-gatekept flow are unaffected.
-- ====================================================================

BEGIN;

-- Capability flag on the assistant->principal relationship.
ALTER TABLE assistant_assignments
    ADD COLUMN IF NOT EXISTS can_gatekeep BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN assistant_assignments.can_gatekeep IS
    'Screen the principal''s incoming approvals before they reach the principal (forward or return to requestor).';

-- Screening state on the individual approval step.
ALTER TABLE request_steps
    ADD COLUMN IF NOT EXISTS screening_status TEXT,
    ADD COLUMN IF NOT EXISTS screener_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS screened_at TIMESTAMPTZ;

COMMENT ON COLUMN request_steps.screening_status IS
    'NULL = not screened; pending_screen = awaiting a gatekeeper''s decision; forwarded = released to the approver; returned = sent back to the requestor.';
COMMENT ON COLUMN request_steps.screener_id IS
    'The gatekeeping assistant who resolved the screen (forwarded/returned).';
COMMENT ON COLUMN request_steps.screened_at IS
    'When the screen was resolved.';

-- Fast lookup of steps currently awaiting screening.
CREATE INDEX IF NOT EXISTS idx_request_steps_pending_screen
    ON request_steps(approver_user_id)
    WHERE screening_status = 'pending_screen';

COMMIT;
