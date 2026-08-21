-- ============================================================
-- Track when each attendee was last emailed their sign / check-in link (BGM)
-- ============================================================
-- Lets the attendance register show "link sent {time}" per attendee — most
-- useful when chasing sign-off for a past / recorded meeting.
-- Idempotent.
-- ============================================================
ALTER TABLE meeting_attendance
  ADD COLUMN IF NOT EXISTS checkin_link_sent_at TIMESTAMPTZ;
ALTER TABLE meeting_guests
  ADD COLUMN IF NOT EXISTS checkin_link_sent_at TIMESTAMPTZ;
