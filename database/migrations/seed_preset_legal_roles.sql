-- ============================================================
-- Preset, assignable legal roles
-- ============================================================
-- Gives admins ready-made roles to tailor exactly what each legal user sees,
-- on top of the existing "Legal Super-Admin" / "Legal Team Member" roles.
-- The legal pages already gate view vs. manage per area (bgm.*.view / .manage),
-- so assigning one of these roles in Admin → Access & Rights is all that's
-- needed. is_system = false ⇒ these can be edited/removed from the UI.
--
-- Idempotent: safe to re-run. Applied to THE CIRCLE STAGING on 2026-08-18;
-- apply to production before promoting the legal module there.
-- ============================================================
DO $$
DECLARE
    v_org UUID;
    v_role UUID;
BEGIN
    SELECT id INTO v_org FROM organizations WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%' LIMIT 1;
    IF v_org IS NULL THEN SELECT id INTO v_org FROM organizations LIMIT 1; END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'No organization found.'; END IF;

    -- 1. Legal Viewer — read-only across the legal module.
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org, 'Legal Viewer', 'legal_viewer',
        'Read-only access to the Legal module: view board meetings, directors, attendance registers and governance reports. Cannot create or edit.',
        'gray', false, false, 30)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_role;
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role, p.id FROM permissions p
    WHERE p.code IN ('legal.access','bgm.meetings.view','bgm.directors.view','bgm.attendance.view','bgm.reports.view')
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- 2. Legal — Board Meetings: manage meetings & attendance (reads directors as invitees).
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org, 'Legal — Board Meetings', 'legal_meetings',
        'Schedule and run board/committee meetings and manage attendance registers. Can view directors (as invitees) and governance reports, but not edit the director register.',
        'indigo', false, false, 38)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_role;
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role, p.id FROM permissions p
    WHERE p.code IN ('legal.access','bgm.meetings.view','bgm.meetings.manage','bgm.attendance.view','bgm.attendance.manage','bgm.directors.view','bgm.reports.view')
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- 3. Legal — Directors & Committees: manage the director register and committees.
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org, 'Legal — Directors & Committees', 'legal_directors',
        'Maintain director profiles and board committee structures. Does not manage meetings or attendance.',
        'purple', false, false, 36)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_role;
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role, p.id FROM permissions p
    WHERE p.code IN ('legal.access','bgm.directors.view','bgm.directors.manage','bgm.committees.manage')
    ON CONFLICT (role_id, permission_id) DO NOTHING;
END $$;
