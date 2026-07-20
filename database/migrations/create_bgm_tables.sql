-- ============================================================
-- Legal Module — Board Governance, Register Management &
-- Meeting Administration (BGM)
-- ============================================================
-- Covers the data model for:
--   BGM-01  Smart Multi-Calendar Meeting Administration
--   BGM-02  Digital Board Attendance Register
-- and lays the groundwork (directors, committees) for the later
-- Director Self-Service Portal (BGM-05/07).
--
-- Design notes:
--   * Directors are NOT app_users. Board members are external to RTG and
--     live in their own `directors` table so they never enter RTG's identity
--     surface (approver pickers, user lists, RBAC assignment). Their portal
--     authentication (magic-link / tokenised links) is a later phase.
--   * Meetings are administered by legal staff (app_users). Attendance is a
--     row-per-invited-director register: a row's presence = invited; its
--     status = actual attendance (null until recorded).
--   * Service-role writes bypass RLS; SELECT policies scope reads to the org.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Committees (board sub-committees + the main board)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS committees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    is_main_board BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(organization_id, slug)
);

-- ------------------------------------------------------------
-- 2. Directors (board members — external to RTG staff)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    salutation TEXT,                     -- Mr / Mrs / Dr ...
    email TEXT,                          -- nullable: must be set before Outlook invites work
    phone TEXT,
    -- Governance / tenure
    appointed_date DATE,
    term_end_date DATE,
    is_independent BOOLEAN,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'resigned', 'retired', 'suspended')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(organization_id, full_name)
);

-- ------------------------------------------------------------
-- 3. Committee memberships (which director sits on which committee)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS committee_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    committee_id UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
    director_id UUID NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
    is_chair BOOLEAN NOT NULL DEFAULT false,
    role_title TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(committee_id, director_id)
);

-- ------------------------------------------------------------
-- 4. Board / committee meetings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    meeting_type TEXT NOT NULL DEFAULT 'board'
        CHECK (meeting_type IN ('board', 'committee')),
    committee_id UUID REFERENCES committees(id) ON DELETE SET NULL,
    -- Schedule
    scheduled_start TIMESTAMPTZ NOT NULL,
    scheduled_end TIMESTAMPTZ,
    time_zone TEXT NOT NULL DEFAULT 'Africa/Harare',
    location TEXT,
    is_virtual BOOLEAN NOT NULL DEFAULT false,
    virtual_link TEXT,
    agenda TEXT,
    -- Annual board calendar grouping
    calendar_year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    -- Microsoft Outlook / Graph sync (BGM-01 invitations)
    outlook_event_id TEXT,
    outlook_web_link TEXT,
    invitations_sent_at TIMESTAMPTZ,
    -- Automated reminder dedupe (BGM-01): 7-day and 1-day milestones
    reminded_7d BOOLEAN NOT NULL DEFAULT false,
    reminded_1d BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_board_meetings_org ON board_meetings(organization_id);
CREATE INDEX IF NOT EXISTS idx_board_meetings_year ON board_meetings(organization_id, calendar_year);
CREATE INDEX IF NOT EXISTS idx_board_meetings_committee ON board_meetings(committee_id);
CREATE INDEX IF NOT EXISTS idx_board_meetings_start ON board_meetings(scheduled_start);

-- ------------------------------------------------------------
-- 5. Attendance register (one row per invited director per meeting)
--    Presence of a row = invited. status = actual attendance (BGM-02).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES board_meetings(id) ON DELETE CASCADE,
    director_id UUID NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
    status TEXT
        CHECK (status IS NULL OR status IN ('present', 'virtual', 'apology', 'absent')),
    note TEXT,
    -- Self-service confirmation hooks (used by BGM-05/07 later)
    confirmed_by_director BOOLEAN NOT NULL DEFAULT false,
    recorded_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(meeting_id, director_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_attendance_meeting ON meeting_attendance(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_attendance_director ON meeting_attendance(director_id);

-- ------------------------------------------------------------
-- 6. updated_at touch triggers (reuse if a shared function exists)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION bgm_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_committees_touch') THEN
        CREATE TRIGGER trg_committees_touch BEFORE UPDATE ON committees
            FOR EACH ROW EXECUTE FUNCTION bgm_touch_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_directors_touch') THEN
        CREATE TRIGGER trg_directors_touch BEFORE UPDATE ON directors
            FOR EACH ROW EXECUTE FUNCTION bgm_touch_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_board_meetings_touch') THEN
        CREATE TRIGGER trg_board_meetings_touch BEFORE UPDATE ON board_meetings
            FOR EACH ROW EXECUTE FUNCTION bgm_touch_updated_at();
    END IF;
END $$;

-- ============================================================
-- 7. RLS — service-role writes bypass RLS; reads scoped to the org.
-- ============================================================
ALTER TABLE committees ENABLE ROW LEVEL SECURITY;
ALTER TABLE directors ENABLE ROW LEVEL SECURITY;
ALTER TABLE committee_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_attendance ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'committees' AND policyname = 'Org members can view committees') THEN
        CREATE POLICY "Org members can view committees" ON committees FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'directors' AND policyname = 'Org members can view directors') THEN
        CREATE POLICY "Org members can view directors" ON directors FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'committee_memberships' AND policyname = 'Org members can view memberships') THEN
        CREATE POLICY "Org members can view memberships" ON committee_memberships FOR SELECT
          USING (committee_id IN (
            SELECT id FROM committees
            WHERE organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid())
          ));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'board_meetings' AND policyname = 'Org members can view meetings') THEN
        CREATE POLICY "Org members can view meetings" ON board_meetings FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'meeting_attendance' AND policyname = 'Org members can view attendance') THEN
        CREATE POLICY "Org members can view attendance" ON meeting_attendance FOR SELECT
          USING (meeting_id IN (
            SELECT id FROM board_meetings
            WHERE organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid())
          ));
    END IF;
END $$;

-- ============================================================
-- 8. RBAC — Legal module permissions + roles
-- ============================================================
INSERT INTO permissions (code, name, description, category) VALUES
    ('legal.access',          'Access Legal Module',      'Enter the Legal module (Contracts, Compliance, Board Governance)', 'legal'),
    ('bgm.meetings.view',     'View Board Meetings',      'View the board calendar and meeting schedules',                   'legal'),
    ('bgm.meetings.manage',   'Manage Board Meetings',    'Schedule, edit, cancel meetings and send Outlook invitations',    'legal'),
    ('bgm.attendance.view',   'View Attendance Register', 'View attendance registers and per-director history',              'legal'),
    ('bgm.attendance.manage', 'Manage Attendance',        'Record and amend meeting attendance statuses',                    'legal'),
    ('bgm.directors.view',    'View Directors',           'View director profiles and committee compositions',               'legal'),
    ('bgm.directors.manage',  'Manage Directors',         'Create and edit director profiles and committee memberships',     'legal'),
    ('bgm.committees.manage', 'Manage Committees',        'Create and edit board committees and their structure',            'legal'),
    ('bgm.reports.view',      'View Governance Reports',  'View governance dashboards and export reports',                   'legal')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 9. Legal roles + board structure seed (org-scoped)
-- ============================================================
DO $$
DECLARE
    v_org UUID;
    v_super_admin_role UUID;
    v_legal_super_role UUID;
    v_legal_member_role UUID;
BEGIN
    SELECT id INTO v_org FROM organizations WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%' LIMIT 1;
    IF v_org IS NULL THEN SELECT id INTO v_org FROM organizations LIMIT 1; END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'No organization found. Create an organization first.'; END IF;

    -- --- Legal Super-Admin: full legal + governance control ---
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org, 'Legal Super-Admin', 'legal_super_admin',
        'Full configuration of the Legal module — contract types, compliance categories, committee structures and registers. Manages all board governance, meetings, attendance, directors and reports.',
        'amber', true, false, 85)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_legal_super_role;

    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_legal_super_role, p.id FROM permissions p WHERE p.category = 'legal'
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- --- Legal Team Member: day-to-day BGM administration ---
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org, 'Legal Team Member', 'legal_team_member',
        'Schedules board and committee meetings, manages attendance registers, administers director profiles and issues governance declarations.',
        'teal', true, false, 40)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_legal_member_role;

    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_legal_member_role, p.id FROM permissions p
    WHERE p.code IN (
        'legal.access',
        'bgm.meetings.view', 'bgm.meetings.manage',
        'bgm.attendance.view', 'bgm.attendance.manage',
        'bgm.directors.view', 'bgm.directors.manage',
        'bgm.reports.view'
    )
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- --- Keep the existing Super Admin role holding the new permissions too
    --     (super_admin bypasses checks at runtime, but reflect it in the grid) ---
    SELECT id INTO v_super_admin_role FROM roles WHERE organization_id = v_org AND slug = 'super_admin' LIMIT 1;
    IF v_super_admin_role IS NOT NULL THEN
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT v_super_admin_role, p.id FROM permissions p WHERE p.category = 'legal'
        ON CONFLICT (role_id, permission_id) DO NOTHING;
    END IF;

    -- ============================================================
    -- Board structure seed (from Legal SRS v2.0, §2)
    -- Idempotent: re-running only fills gaps.
    -- ============================================================

    -- Committees
    INSERT INTO committees (organization_id, name, slug, is_main_board) VALUES
        (v_org, 'Main Board and AGM',                     'main-board-agm',                true),
        (v_org, 'Audit, Risk and Sustainability',         'audit-risk-sustainability',     false),
        (v_org, 'Strategy, Growth and Investments',       'strategy-growth-investments',   false),
        (v_org, 'Commercial and Operations',              'commercial-operations',         false),
        (v_org, 'Technology & Business Reengineering',    'technology-business-reeng',     false),
        (v_org, 'HR Governance and Nominations',          'hr-governance-nominations',     false)
    ON CONFLICT (organization_id, slug) DO NOTHING;

    -- Directors (names as recorded in the SRS; emails to be captured by Legal)
    INSERT INTO directors (organization_id, full_name, salutation) VALUES
        (v_org, 'Mr. Kenzias Chibota',   'Mr.'),
        (v_org, 'Dr. G. Taputaira',      'Dr.'),
        (v_org, 'Mrs. C. Mafunga',       'Mrs.'),
        (v_org, 'Mr. Kumbirai Gundani',  'Mr.'),
        (v_org, 'Mr. Douglas Hoto',      'Mr.'),
        (v_org, 'Mr. Douglas Mavhembu',  'Mr.'),
        (v_org, 'Dr. Langton Mabhanga',  'Dr.'),
        (v_org, 'Mrs. Cynthia Malaba',   'Mrs.'),
        (v_org, 'Mr. A. Bvumbe',         'Mr.')
    ON CONFLICT (organization_id, full_name) DO NOTHING;

    -- Committee memberships (chair flagged)
    WITH seed(committee_slug, director_name, is_chair) AS (
        VALUES
            -- Audit, Risk and Sustainability
            ('audit-risk-sustainability',   'Mr. Kenzias Chibota',  true),
            ('audit-risk-sustainability',   'Dr. G. Taputaira',     false),
            ('audit-risk-sustainability',   'Mrs. C. Mafunga',      false),
            -- Strategy, Growth and Investments
            ('strategy-growth-investments', 'Mr. Kumbirai Gundani', true),
            ('strategy-growth-investments', 'Mrs. C. Mafunga',      false),
            ('strategy-growth-investments', 'Mr. Douglas Hoto',     false),
            ('strategy-growth-investments', 'Mr. Douglas Mavhembu', false),
            -- Commercial and Operations
            ('commercial-operations',       'Dr. Langton Mabhanga', true),
            ('commercial-operations',       'Mrs. Cynthia Malaba',  false),
            ('commercial-operations',       'Mr. Kenzias Chibota',  false),
            -- Technology & Business Reengineering
            ('technology-business-reeng',   'Mrs. Cynthia Malaba',  true),
            ('technology-business-reeng',   'Dr. G. Taputaira',     false),
            ('technology-business-reeng',   'Mr. A. Bvumbe',        false),
            -- HR Governance and Nominations
            ('hr-governance-nominations',   'Mr. Douglas Mavhembu', true),
            ('hr-governance-nominations',   'Mr. Douglas Hoto',     false),
            ('hr-governance-nominations',   'Dr. Langton Mabhanga', false),
            -- Main Board and AGM (chair = Hoto; all directors are members)
            ('main-board-agm',              'Mr. Douglas Hoto',     true),
            ('main-board-agm',              'Mr. Kenzias Chibota',  false),
            ('main-board-agm',              'Dr. G. Taputaira',     false),
            ('main-board-agm',              'Mrs. C. Mafunga',      false),
            ('main-board-agm',              'Mr. Kumbirai Gundani', false),
            ('main-board-agm',              'Mr. Douglas Mavhembu', false),
            ('main-board-agm',              'Dr. Langton Mabhanga', false),
            ('main-board-agm',              'Mrs. Cynthia Malaba',  false),
            ('main-board-agm',              'Mr. A. Bvumbe',        false)
    )
    INSERT INTO committee_memberships (committee_id, director_id, is_chair)
    SELECT c.id, d.id, s.is_chair
    FROM seed s
    JOIN committees c ON c.organization_id = v_org AND c.slug = s.committee_slug
    JOIN directors  d ON d.organization_id = v_org AND d.full_name = s.director_name
    ON CONFLICT (committee_id, director_id) DO UPDATE SET is_chair = EXCLUDED.is_chair;

    RAISE NOTICE 'BGM schema + board structure seeded for org %', v_org;
END $$;
