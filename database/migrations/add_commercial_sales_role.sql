-- ============================================================
-- Commercial / Sales role
-- Adds a "Commercial / Sales" role for the commercial/sales
-- department. Members can view the voucher register (receipts /
-- generation records) and raise complimentary voucher requests.
-- Idempotent — safe to re-run.
-- Run AFTER create_rbac_tables.sql, seed_rbac_roles.sql and
-- add_voucher_permissions.sql.
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

    -- Make sure the voucher permissions exist (mirrors add_voucher_permissions.sql).
    INSERT INTO permissions (code, name, description, category) VALUES
        ('vouchers.create', 'Create Vouchers', 'Raise complimentary voucher requests', 'vouchers'),
        ('vouchers.view_register', 'View Voucher Register', 'View the voucher register / booklet and generation records', 'vouchers')
    ON CONFLICT (code) DO NOTHING;

    -- Create (or refresh) the Commercial / Sales role.
    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org_id, 'Commercial / Sales', 'commercial_sales',
        'Commercial and sales department. Can view the voucher register (receipts and generation records) and raise complimentary voucher requests.',
        'emerald', true, false, 40)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_role_id;

    -- Grant voucher permissions plus the basic request permissions needed to
    -- actually raise and track a voucher request.
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role_id, p.id FROM permissions p
    WHERE p.code IN (
        'vouchers.create',
        'vouchers.view_register',
        'requests.create',
        'requests.view_own',
        'archives.view_own',
        'archives.download'
    )
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    RAISE NOTICE 'Commercial / Sales role seeded: %', v_role_id;
END $$;
