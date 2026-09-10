-- ============================================================
-- HR Admin — file requests on behalf of anyone
--
-- Assistants may file for the specific principals a systems admin
-- assigned them (assistant_assignments). HR admins need a broader
-- right: filing travel and complimentary accommodation requests for
-- ANY employee, and for guests who are not part of the organization
-- at all.
--
-- That is granted by `requests.file_on_behalf_any`, held here by an
-- "HR Admin" role. The permission — not the role — is what the code
-- checks, so the right can also be granted to any other role or to an
-- individual via a user override.
--
-- Idempotent — safe to re-run.
-- Run AFTER create_rbac_tables.sql and seed_rbac_roles.sql.
-- ============================================================

DO $$
DECLARE
    v_org_id UUID;
    v_role_id UUID;
BEGIN
    -- Resolve the RTG organization (fall back to any org).
    SELECT id INTO v_org_id FROM organizations WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%' LIMIT 1;
    IF v_org_id IS NULL THEN
        SELECT id INTO v_org_id FROM organizations LIMIT 1;
    END IF;
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'No organization found. Please create an organization first.';
    END IF;

    INSERT INTO permissions (code, name, description, category) VALUES
        ('requests.file_on_behalf_any',
         'File Requests for Anyone',
         'File requests on behalf of any employee, or on behalf of a guest outside the organization, without needing an assistant assignment',
         'requests')
    ON CONFLICT (code) DO NOTHING;

    -- Create (or refresh) the HR Admin role.
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org_id, 'HR Admin', 'hr_admin',
        'Human Resources administrator. Can file travel and complimentary accommodation requests on behalf of any employee or external guest.',
        'violet', true, false, 45)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_role_id;

    -- The on-behalf right, plus what is needed to actually raise and track
    -- the requests they file.
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role_id, p.id FROM permissions p
    WHERE p.code IN (
        'requests.file_on_behalf_any',
        'requests.create',
        'requests.view_own',
        'requests.edit_own',
        'requests.withdraw',
        'archives.view_own',
        'archives.download'
    )
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    RAISE NOTICE 'HR Admin role seeded: %', v_role_id;
END $$;
