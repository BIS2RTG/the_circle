-- ============================================================
-- Board-member self-service: saved signature, terms acceptance, HRIMS flag
-- ============================================================
-- Adds the columns behind the director self-sign flow (BGM):
--   * saved_signature    — reusable signature (data URL) captured on first
--                          self-sign; offered again on later signs.
--   * saved_signature_at — when it was captured.
--   * terms_accepted_at  — when a non-HRIMS (external) board member accepted the
--                          governance terms; required before their first sign.
--   * is_hrims           — manual override. TRUE = staff/HRIMS member,
--                          FALSE = external. NULL = auto-detect by matching the
--                          director's email to a staff (app_users) login.
-- Idempotent.
-- ============================================================
ALTER TABLE directors
  ADD COLUMN IF NOT EXISTS saved_signature TEXT,
  ADD COLUMN IF NOT EXISTS saved_signature_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_hrims BOOLEAN;

COMMENT ON COLUMN directors.saved_signature IS 'Reusable signature (data URL) captured on first self-sign; offered on later signs.';
COMMENT ON COLUMN directors.terms_accepted_at IS 'When this (non-HRIMS) board member accepted the governance terms before signing.';
COMMENT ON COLUMN directors.is_hrims IS 'Manual override: TRUE=staff/HRIMS, FALSE=external. NULL=auto-detect by email match to app_users.';
