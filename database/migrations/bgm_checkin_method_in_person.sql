-- ============================================================
-- BGM — add 'in_person' check-in method
-- ============================================================
-- Used when the board member signs on the legal admin's device at the meeting
-- (distinct from 'secretary', which is a plain mark without a signature).
-- ============================================================

ALTER TABLE meeting_attendance DROP CONSTRAINT IF EXISTS meeting_attendance_check_in_method_check;
ALTER TABLE meeting_attendance ADD CONSTRAINT meeting_attendance_check_in_method_check
    CHECK (check_in_method IS NULL OR check_in_method IN ('secretary', 'self_qr', 'self_token', 'teams', 'import', 'in_person'));
