-- ============================================================
-- Legal Module — BGM-04  Board Resolution & Action Tracker
-- ============================================================
-- A centralised repository mapping board/committee resolutions to the
-- responsible owners who must action them, with deadlines, live status and
-- automated progress notifications.
--
--   board_resolutions       — a resolution passed by the board / a committee
--   resolution_tasks        — the discrete action item(s) a resolution spawns,
--                             each assigned to a responsible owner (an app_user)
--                             with a deadline and a live status.
--   resolution_task_updates — append-only progress log (status changes + notes)
--                             feeding the audit trail and progress notifications.
--
-- Status model:
--   Stored status is pending / in_progress / resolved. "Overdue" is DERIVED
--   (due_date < today AND status <> 'resolved') so it can never drift from the
--   clock — the UI and the cron compute it. See lib/bgmResolutions.ts.
--
-- Owners are RTG staff (app_users) — resolutions are actioned by management, so
-- unlike directors they belong on the internal identity surface and reuse the
-- existing user picker. A free-text owner_name is kept as a fallback label.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Resolutions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_resolutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    meeting_id UUID REFERENCES board_meetings(id) ON DELETE SET NULL,
    committee_id UUID REFERENCES committees(id) ON DELETE SET NULL,
    reference TEXT,                       -- e.g. "RES-2026-014" (optional, human ref)
    title TEXT NOT NULL,
    description TEXT,                      -- the resolution text as minuted
    category TEXT,                        -- optional grouping (Finance, Strategy, Governance…)
    resolution_date DATE,                 -- date passed
    is_archived BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_board_res_org      ON board_resolutions(organization_id);
CREATE INDEX IF NOT EXISTS idx_board_res_meeting  ON board_resolutions(meeting_id);

-- ------------------------------------------------------------
-- 2. Resolution tasks (action items with an owner + deadline)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolution_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    resolution_id UUID NOT NULL REFERENCES board_resolutions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    owner_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    owner_name TEXT,                      -- fallback / external owner label
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'resolved')),
    progress_note TEXT,                   -- latest owner note (denormalised for lists)
    resolved_at TIMESTAMPTZ,

    -- Automated-notification dedupe (cron in /api/cron/bgm-resolution-reminders)
    notified_due_soon BOOLEAN NOT NULL DEFAULT false,
    notified_overdue BOOLEAN NOT NULL DEFAULT false,

    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_res_tasks_org        ON resolution_tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_res_tasks_resolution ON resolution_tasks(resolution_id);
CREATE INDEX IF NOT EXISTS idx_res_tasks_owner      ON resolution_tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_res_tasks_status     ON resolution_tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_res_tasks_due        ON resolution_tasks(due_date);

-- ------------------------------------------------------------
-- 3. Append-only progress log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolution_task_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES resolution_tasks(id) ON DELETE CASCADE,
    status TEXT
        CHECK (status IS NULL OR status IN ('pending', 'in_progress', 'resolved')),
    note TEXT,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_res_task_updates_task ON resolution_task_updates(task_id);

-- ------------------------------------------------------------
-- 4. updated_at touch triggers
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_board_res_touch') THEN
        CREATE TRIGGER trg_board_res_touch BEFORE UPDATE ON board_resolutions
            FOR EACH ROW EXECUTE FUNCTION bgm_touch_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_res_tasks_touch') THEN
        CREATE TRIGGER trg_res_tasks_touch BEFORE UPDATE ON resolution_tasks
            FOR EACH ROW EXECUTE FUNCTION bgm_touch_updated_at();
    END IF;
END $$;

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------
ALTER TABLE board_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_task_updates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'board_resolutions' AND policyname = 'Org members can view resolutions') THEN
        CREATE POLICY "Org members can view resolutions" ON board_resolutions FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'resolution_tasks' AND policyname = 'Org members can view resolution tasks') THEN
        CREATE POLICY "Org members can view resolution tasks" ON resolution_tasks FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'resolution_task_updates' AND policyname = 'Org members can view resolution task updates') THEN
        CREATE POLICY "Org members can view resolution task updates" ON resolution_task_updates FOR SELECT
          USING (organization_id IN (SELECT organization_id FROM app_users WHERE id = auth.uid()));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 6. RBAC — resolution permissions granted to the legal roles.
--    bgm.resolutions.update is deliberately broad-grantable: an owner who is not
--    on the legal team can still be given it to update their own action items
--    (the API also always lets the assigned owner update their own task).
-- ------------------------------------------------------------
INSERT INTO permissions (code, name, description, category) VALUES
    ('bgm.resolutions.view',   'View Resolution Tracker',   'View board resolutions, action items and their status',            'legal'),
    ('bgm.resolutions.manage', 'Manage Resolution Tracker', 'Record resolutions, create and assign action items, set deadlines', 'legal'),
    ('bgm.resolutions.update', 'Update Resolution Actions', 'Update the status and progress of assigned resolution action items','legal')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
    v_org UUID;
    v_role UUID;
BEGIN
    FOR v_org IN SELECT DISTINCT organization_id FROM roles LOOP
        FOR v_role IN
            SELECT id FROM roles WHERE organization_id = v_org AND slug IN ('legal_super_admin', 'super_admin')
        LOOP
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT v_role, p.id FROM permissions p
            WHERE p.code IN ('bgm.resolutions.view', 'bgm.resolutions.manage', 'bgm.resolutions.update')
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END LOOP;

        SELECT id INTO v_role FROM roles WHERE organization_id = v_org AND slug = 'legal_team_member';
        IF v_role IS NOT NULL THEN
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT v_role, p.id FROM permissions p
            WHERE p.code IN ('bgm.resolutions.view', 'bgm.resolutions.manage', 'bgm.resolutions.update')
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END IF;
    END LOOP;
END $$;
