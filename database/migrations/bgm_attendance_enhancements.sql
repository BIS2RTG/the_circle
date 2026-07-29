-- ============================================================
-- BGM enhancements — RSVP, check-in provenance, quorum/finalize,
-- non-director guests, scheduled invitations, custom invitees.
-- Builds on create_bgm_tables.sql. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. board_meetings: scheduled sending, invite scope, quorum, finalize
-- ------------------------------------------------------------
ALTER TABLE board_meetings
    ADD COLUMN IF NOT EXISTS invitations_scheduled_for TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS invite_scope TEXT
        CHECK (invite_scope IS NULL OR invite_scope IN ('all_board', 'committee', 'custom')),
    ADD COLUMN IF NOT EXISTS quorum INTEGER,
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalized_by UUID REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_board_meetings_sched_send
    ON board_meetings(invitations_scheduled_for)
    WHERE invitations_scheduled_for IS NOT NULL AND invitations_sent_at IS NULL;

-- ------------------------------------------------------------
-- 2. meeting_attendance: RSVP + check-in provenance
-- ------------------------------------------------------------
ALTER TABLE meeting_attendance
    ADD COLUMN IF NOT EXISTS rsvp_status TEXT NOT NULL DEFAULT 'no_response'
        CHECK (rsvp_status IN ('no_response', 'accepted', 'declined', 'tentative')),
    ADD COLUMN IF NOT EXISTS rsvp_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rsvp_note TEXT,
    ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS check_in_method TEXT
        CHECK (check_in_method IS NULL OR check_in_method IN ('secretary', 'self_qr', 'self_token', 'teams', 'import'));

-- ------------------------------------------------------------
-- 3. meeting_guests — non-director invitees (management, company
--    secretary, external advisors). Kept OUT of meeting_attendance so
--    director cumulative stats and quorum stay pure. app_user_id/azure_oid
--    are set when the guest was picked from the AD directory.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES board_meetings(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    email TEXT,
    organization TEXT,
    role TEXT,                            -- e.g. 'Company Secretary', 'Management', 'Advisor'
    app_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    azure_oid TEXT,
    rsvp_status TEXT NOT NULL DEFAULT 'no_response'
        CHECK (rsvp_status IN ('no_response', 'accepted', 'declined', 'tentative')),
    status TEXT
        CHECK (status IS NULL OR status IN ('present', 'virtual', 'apology', 'absent')),
    note TEXT,
    checked_in_at TIMESTAMPTZ,
    recorded_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_guests_meeting ON meeting_guests(meeting_id);

ALTER TABLE meeting_guests ENABLE ROW LEVEL SECURITY;

DO $pol$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'meeting_guests' AND policyname = 'Org members can view meeting guests') THEN
        CREATE POLICY "Org members can view meeting guests" ON meeting_guests FOR SELECT
          USING (meeting_id IN (
            SELECT id FROM board_meetings
            WHERE organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid())
          ));
    END IF;
END $pol$;
