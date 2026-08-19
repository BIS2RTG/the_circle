-- ============================================================
-- Legal Module — BGM-05 Director Self-Service Portal &
--                BGM-07 Secure Tokenised Director Links
-- ============================================================
-- Directors are external to RTG (no app_users row). This gives them a
-- ring-fenced, passwordless way to interact with governance:
--
--   * BGM-07 single-action links — time-limited (default 7 days, configurable),
--     single-use links emailed to a director to complete one specific action
--     (confirm attendance, sign a declaration, update their profile) from any
--     device with no login. Raw tokens are NEVER stored — only a SHA-256 hash;
--     the raw token lives only in the emailed URL.
--
--   * BGM-05 portal sessions — a portal_login link establishes a short-lived,
--     DB-backed, revocable session (httpOnly cookie holds a random secret whose
--     hash is stored here) giving the director a dashboard: meeting schedule,
--     attendance confirmation and governance declarations.
--
--   * Immutable audit trail — every access event (issued / opened / completed /
--     expired / invalid / login / logout / denied …) is recorded in
--     director_access_events, which a trigger makes append-only (UPDATE/DELETE
--     raise, even for the service role).
--
-- The configurable default link lifetime is stored in system_settings
-- (category 'preferences', key 'director_token_days'); default 7.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Single-action / login tokens (hashed, single-use, expiring)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS director_action_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    director_id UUID NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
    action TEXT NOT NULL
        CHECK (action IN ('portal_login', 'confirm_attendance', 'sign_declaration', 'update_profile')),
    -- What the action targets (a meeting to confirm, a declaration to sign …)
    target_type TEXT CHECK (target_type IS NULL OR target_type IN ('meeting', 'declaration')),
    target_id UUID,
    -- SHA-256 hex of the raw token (raw token only ever appears in the email URL)
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dtok_hash     ON director_action_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_dtok_director ON director_action_tokens(director_id);
CREATE INDEX IF NOT EXISTS idx_dtok_org      ON director_action_tokens(organization_id);

-- ------------------------------------------------------------
-- 2. Portal sessions (DB-backed, revocable; cookie holds the secret)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS director_portal_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    director_id UUID NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL UNIQUE,       -- SHA-256 of the cookie secret
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    ip TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_dsess_hash     ON director_portal_sessions(session_hash);
CREATE INDEX IF NOT EXISTS idx_dsess_director ON director_portal_sessions(director_id);

-- ------------------------------------------------------------
-- 3. Immutable access audit trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS director_access_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    director_id UUID REFERENCES directors(id) ON DELETE SET NULL,
    token_id UUID,                           -- soft ref (tokens may be pruned)
    session_id UUID,
    action TEXT,
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'token_issued', 'token_opened', 'token_completed', 'token_expired',
            'token_invalid', 'token_revoked', 'login', 'logout', 'session_expired',
            'profile_updated', 'attendance_confirmed', 'declaration_signed',
            'viewed', 'denied'
        )),
    detail TEXT,
    ip TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devent_org      ON director_access_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devent_director ON director_access_events(director_id, created_at DESC);

-- Append-only: block UPDATE and DELETE (even for the service role).
CREATE OR REPLACE FUNCTION director_access_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'director_access_events is an immutable audit trail; % is not permitted', TG_OP;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_devent_immutable') THEN
        CREATE TRIGGER trg_devent_immutable
            BEFORE UPDATE OR DELETE ON director_access_events
            FOR EACH ROW EXECUTE FUNCTION director_access_events_immutable();
    END IF;
END $$;

-- ------------------------------------------------------------
-- 4. RLS — service-role writes bypass RLS; reads scoped to the org.
--    (Public token/portal routes read via the service role, not anon.)
-- ------------------------------------------------------------
ALTER TABLE director_action_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_access_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'director_action_tokens' AND policyname = 'Org members can view director tokens') THEN
        CREATE POLICY "Org members can view director tokens" ON director_action_tokens FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'director_access_events' AND policyname = 'Org members can view director access events') THEN
        CREATE POLICY "Org members can view director access events" ON director_access_events FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;
    -- Sessions are internal; no anon/authenticated SELECT policy (service role only).
END $$;

-- ------------------------------------------------------------
-- 5. RBAC — portal management permissions granted to the legal roles.
-- ------------------------------------------------------------
INSERT INTO permissions (code, name, description, category) VALUES
    ('bgm.portal.view',   'View Director Portal Access', 'View the director access audit trail and portal/link activity', 'legal'),
    ('bgm.portal.manage', 'Manage Director Portal',      'Issue secure director links, send portal invitations and revoke access', 'legal')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
    v_org UUID;
    v_role UUID;
BEGIN
    FOR v_org IN SELECT DISTINCT organization_id FROM roles LOOP
        FOR v_role IN SELECT id FROM roles WHERE organization_id = v_org AND slug IN ('legal_super_admin', 'super_admin') LOOP
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT v_role, p.id FROM permissions p WHERE p.code IN ('bgm.portal.view', 'bgm.portal.manage')
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END LOOP;
        SELECT id INTO v_role FROM roles WHERE organization_id = v_org AND slug = 'legal_team_member';
        IF v_role IS NOT NULL THEN
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT v_role, p.id FROM permissions p WHERE p.code IN ('bgm.portal.view', 'bgm.portal.manage')
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END IF;
    END LOOP;
END $$;
