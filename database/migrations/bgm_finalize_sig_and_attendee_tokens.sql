-- ============================================================
-- BGM — finalize signature + per-attendee self check-in tokens
-- ============================================================
-- * board_meetings.finalized_signature: the signature of the person who
--   finalizes the register; shown at the bottom of the attendance report.
-- * meeting_attendance/meeting_guests.checkin_token: a UNIQUE per-attendee
--   token behind a personalised self check-in link ("Good day, Mr X, sign
--   here"). Time-limited by the meeting window; single registration enforced
--   in the API once the attendee has checked in.
-- ============================================================

ALTER TABLE board_meetings ADD COLUMN IF NOT EXISTS finalized_signature TEXT;

ALTER TABLE meeting_attendance ADD COLUMN IF NOT EXISTS checkin_token TEXT;
ALTER TABLE meeting_guests     ADD COLUMN IF NOT EXISTS checkin_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_attendance_token
    ON meeting_attendance(checkin_token) WHERE checkin_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_guests_token
    ON meeting_guests(checkin_token) WHERE checkin_token IS NOT NULL;
