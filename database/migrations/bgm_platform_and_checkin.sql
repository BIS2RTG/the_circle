-- ============================================================
-- BGM — virtual meeting platform + QR self check-in token
-- ============================================================
-- * virtual_platform: which conferencing tool a hybrid/virtual meeting uses.
--   RTG boards use Zoom (single licence, link created manually by IT), but
--   Teams / Google Meet / Other are supported. Teams links can be auto-created
--   through Graph; all others are pasted in.
-- * check_in_token: opaque token behind a per-meeting QR code enabling
--   on-the-day self check-in without a full portal login (pre-cursor to
--   BGM-07 tokenised links). Rotatable; nullable until first generated.
-- ============================================================

ALTER TABLE board_meetings
    ADD COLUMN IF NOT EXISTS virtual_platform TEXT
        CHECK (virtual_platform IS NULL OR virtual_platform IN ('zoom', 'teams', 'google_meet', 'other')),
    ADD COLUMN IF NOT EXISTS check_in_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_meetings_checkin_token
    ON board_meetings(check_in_token)
    WHERE check_in_token IS NOT NULL;
