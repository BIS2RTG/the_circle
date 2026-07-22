-- ============================================================
-- BGM — capture a signature at QR self check-in
-- ============================================================
-- Attendance is confirmed by the attendee's own signature (the digital
-- equivalent of signing the attendance book), stored as a data URL alongside
-- the check-in. Applies to both directors and guests.
-- ============================================================

ALTER TABLE meeting_attendance ADD COLUMN IF NOT EXISTS check_in_signature TEXT;
ALTER TABLE meeting_guests     ADD COLUMN IF NOT EXISTS check_in_signature TEXT;
