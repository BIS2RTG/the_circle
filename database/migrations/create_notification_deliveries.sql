-- ====================================================================
-- Migration: notification delivery log (emails)
-- ====================================================================
-- In-app notifications are already persisted in `notifications`. Outbound
-- EMAILS, however, were fire-and-forget — nothing recorded who was emailed,
-- which transport carried it, or why a send was skipped. This table captures
-- one row per notification-email attempt so the audit/transactions view can
-- show the complete "who was told, how, and did it land" trail per request.
--
-- Rows are written by lib/notificationEmail.ts for every outcome, including
-- drops (preference off, no address, no transport configured) so the absence
-- of an email is itself auditable.
-- ====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    request_id UUID,
    recipient_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    recipient_email TEXT,
    channel TEXT NOT NULL DEFAULT 'email',
    kind TEXT,                 -- approval_tasks | reminder | completion | request_updates | digest
    subject TEXT,
    transport TEXT,            -- graph_delegated_actor | graph_app_mail | resend | graph_delegated_recipient
    success BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,               -- transport label on success; preference_off | no_email | not_configured | error on drop
    actor_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_request
    ON notification_deliveries(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient
    ON notification_deliveries(recipient_id, created_at DESC);

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

-- Service-role only (the app uses supabaseAdmin); mirrors permanent_watchers.
CREATE POLICY "Service role manages notification deliveries"
    ON notification_deliveries FOR ALL
    USING (auth.role() = 'service_role');

COMMENT ON TABLE notification_deliveries IS
    'Append-only log of outbound notification EMAILS (one row per attempt, including drops). In-app notifications live in notifications.';

COMMIT;
