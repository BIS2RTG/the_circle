-- ============================================================
-- Legal Module — BGM-03  Electronic Governance Declarations
-- ============================================================
-- Replaces the paper governance forms with digital, e-signed
-- versions. Five declaration types:
--   * director_information     — biographical / contact / directorships
--   * declaration_of_interest  — declarable interests register feed
--   * related_party            — related-party transactions register feed
--   * annual_governance        — annual code-of-conduct / fit-&-proper attestation
--   * board_evaluation         — board & committee effectiveness questionnaire
--
-- Design notes:
--   * Directors are external to RTG (see create_bgm_tables.sql). A declaration is
--     ISSUED by legal staff and completed by the director through a tokenised,
--     login-free link — the same pattern as the personalised attendance links.
--     Staff may also fill on behalf and capture the signature in person.
--   * `form_data` is a JSONB payload whose shape is defined per type in
--     lib/bgmDeclarations.ts (client-safe). Structured register feeds (interests,
--     related parties) live inside form_data as arrays of entries so the
--     governance registers are a straight projection of submitted declarations.
--   * On submission a director_information declaration auto-populates editable
--     fields on the directors row (auto-populate Director profiles requirement).
--   * Service-role writes bypass RLS; SELECT policies scope reads to the org.
-- ============================================================

CREATE TABLE IF NOT EXISTS governance_declarations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    director_id UUID NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
    declaration_type TEXT NOT NULL
        CHECK (declaration_type IN (
            'director_information',
            'declaration_of_interest',
            'related_party',
            'annual_governance',
            'board_evaluation'
        )),
    -- Governance period this declaration relates to (annual attestations,
    -- board evaluations). Null for ad-hoc / event-driven declarations.
    period_year INTEGER,
    -- Optional link to a meeting (board evaluations are often tied to a sitting).
    meeting_id UUID REFERENCES board_meetings(id) ON DELETE SET NULL,
    title TEXT,                                   -- optional override of the default type title

    status TEXT NOT NULL DEFAULT 'issued'
        CHECK (status IN ('draft', 'issued', 'submitted', 'cancelled')),

    form_data JSONB NOT NULL DEFAULT '{}'::jsonb, -- shape defined per type in lib/bgmDeclarations.ts

    -- E-signature (self-contained data URL — never touches an app_user signature)
    declaration_confirmed BOOLEAN NOT NULL DEFAULT false, -- the attestation checkbox
    signature TEXT,
    signed_name TEXT,
    signed_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    submitted_via TEXT
        CHECK (submitted_via IS NULL OR submitted_via IN ('self_link', 'in_person', 'staff_entry')),

    -- Tokenised, login-free completion link
    access_token TEXT UNIQUE,
    token_expires_at TIMESTAMPTZ,
    due_date DATE,

    -- Provenance / lifecycle
    issued_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    issued_at TIMESTAMPTZ,
    reminded_at TIMESTAMPTZ,
    applied_to_profile BOOLEAN NOT NULL DEFAULT false, -- director_information → directors row

    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gov_decl_org       ON governance_declarations(organization_id);
CREATE INDEX IF NOT EXISTS idx_gov_decl_director  ON governance_declarations(director_id);
CREATE INDEX IF NOT EXISTS idx_gov_decl_type      ON governance_declarations(organization_id, declaration_type);
CREATE INDEX IF NOT EXISTS idx_gov_decl_status    ON governance_declarations(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_gov_decl_token     ON governance_declarations(access_token);

-- updated_at touch trigger (reuses bgm_touch_updated_at from create_bgm_tables.sql)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_gov_decl_touch') THEN
        CREATE TRIGGER trg_gov_decl_touch BEFORE UPDATE ON governance_declarations
            FOR EACH ROW EXECUTE FUNCTION bgm_touch_updated_at();
    END IF;
END $$;

-- ------------------------------------------------------------
-- RLS — service-role writes bypass RLS; reads scoped to the org.
-- ------------------------------------------------------------
ALTER TABLE governance_declarations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'governance_declarations' AND policyname = 'Org members can view declarations') THEN
        CREATE POLICY "Org members can view declarations" ON governance_declarations FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;
END $$;

-- ------------------------------------------------------------
-- RBAC — declaration permissions granted to the legal roles.
-- ------------------------------------------------------------
INSERT INTO permissions (code, name, description, category) VALUES
    ('bgm.declarations.view',   'View Governance Declarations',   'View governance declarations and the interests / related-party registers', 'legal'),
    ('bgm.declarations.manage', 'Manage Governance Declarations', 'Issue, complete on behalf of directors, remind and cancel declarations',   'legal')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
    v_org UUID;
    v_role UUID;
BEGIN
    FOR v_org IN SELECT DISTINCT organization_id FROM roles LOOP
        -- Legal Super-Admin & Super Admin get every legal permission.
        FOR v_role IN
            SELECT id FROM roles WHERE organization_id = v_org AND slug IN ('legal_super_admin', 'super_admin')
        LOOP
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT v_role, p.id FROM permissions p
            WHERE p.code IN ('bgm.declarations.view', 'bgm.declarations.manage')
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END LOOP;

        -- Legal Team Member administers declarations day-to-day.
        SELECT id INTO v_role FROM roles WHERE organization_id = v_org AND slug = 'legal_team_member';
        IF v_role IS NOT NULL THEN
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT v_role, p.id FROM permissions p
            WHERE p.code IN ('bgm.declarations.view', 'bgm.declarations.manage')
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END IF;
    END LOOP;
END $$;
