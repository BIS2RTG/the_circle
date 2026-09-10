-- ============================================================
-- Approver role
-- A tag role admins assign (via /admin/roles → Manage Users) to
-- users whose primary function is approving requests rather than
-- creating them (e.g. directors who only sign off). The dashboard
-- uses membership in this role — not the "approvals.*" permissions,
-- which every Employee already holds so ad hoc approval routing
-- keeps working — to decide whether to show approval-focused stats.
-- Idempotent — safe to re-run. Seeds the role for every organization.
-- Run AFTER create_rbac_tables.sql and seed_rbac_roles.sql.
-- ============================================================

DO $$
DECLARE
    v_org RECORD;
    v_role_id UUID;
BEGIN
    FOR v_org IN SELECT id FROM organizations LOOP
        INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
        VALUES (v_org.id, 'Approver', 'approver',
            'Tag role for users whose primary function is approving requests. Drives the approver-focused dashboard view. Does not restrict what the user can already do.',
            'amber', true, false, 45)
        ON CONFLICT (organization_id, slug) DO UPDATE SET
            name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
        RETURNING id INTO v_role_id;

        -- Same baseline permissions as Employee, so tagging someone as an
        -- Approver never takes capability away.
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT v_role_id, p.id FROM permissions p
        WHERE p.code IN (
            'requests.create', 'requests.view_own', 'requests.edit_own', 'requests.withdraw',
            'approvals.view', 'approvals.approve', 'approvals.reject',
            'users.view',
            'reports.view_own',
            'archives.view_own', 'archives.download'
        )
        ON CONFLICT (role_id, permission_id) DO NOTHING;

        RAISE NOTICE 'Approver role seeded for org %: %', v_org.id, v_role_id;
    END LOOP;
END $$;
