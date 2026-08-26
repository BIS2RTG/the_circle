-- ============================================================
-- Post-meeting attendance sign-off reminder tracking (BGM)
-- ============================================================
-- After a meeting has taken place, board members who haven't yet signed for
-- their attendance are chased by the daily cron (/api/cron/bgm-reminders): it
-- re-sends each unsigned member their personal sign link and nudges the legal
-- organiser (email + in-app). These columns cap and de-dupe those rounds.
-- Idempotent.
-- ============================================================
ALTER TABLE board_meetings
  ADD COLUMN IF NOT EXISTS signoff_reminder_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signoff_reminder_last_at TIMESTAMPTZ;

COMMENT ON COLUMN board_meetings.signoff_reminder_count IS 'How many post-meeting sign-off reminder rounds have been sent (capped by the cron).';
COMMENT ON COLUMN board_meetings.signoff_reminder_last_at IS 'When the last sign-off reminder round was sent.';
