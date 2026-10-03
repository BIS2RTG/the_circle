-- ============================================================
-- Multi-Unit Requester — file requests for more than one business unit
--
-- HRIMS records a single business unit per employee, but some staff
-- work across several (e.g. one person covering two hotels). They
-- need to choose, on each request form, which unit they are filing
-- for — and the unit-scoped approvers (CAPEX unit GM, inter-unit
-- From-unit Finance Manager) must follow that choice.
--
-- That is granted by `requests.multi_business_unit`, held here by a
-- "Multi-Unit Requester" role. The permission — not the role — is what
-- the code checks, so it can also be granted to another role or to an
-- individual via a user override.
--
-- WHICH units a user may file for is per user: an admin ticks them in
-- the User Access Manager, stored in user_request_business_units. The
-- user's HRIMS home unit is always available in addition to these.
-- Units are keyed by HRIMS business_units.code (stable across HRIMS
-- environments); the name is kept for display.
--
-- Idempotent — safe to re-run.
-- Run AFTER create_rbac_tables.sql and seed_rbac_roles.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_request_business_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    business_unit_code TEXT NOT NULL,
    business_unit_name TEXT NOT NULL,
    assigned_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, business_unit_code)
);

CREATE INDEX IF NOT EXISTS idx_user_request_bus_user ON user_request_business_units(user_id);

ALTER TABLE user_request_business_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage user_request_business_units" ON user_request_business_units;
CREATE POLICY "Service role can manage user_request_business_units"
    ON user_request_business_units FOR ALL USING (auth.role() = 'service_role');

DO $$
DECLARE
    v_org_id UUID;
    v_role_id UUID;
    v_user_id UUID;
BEGIN
    -- Resolve the RTG organization. Refuses to guess (see add_hr_admin_on_behalf.sql).
    SELECT id INTO v_org_id
    FROM organizations
    WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%'
    ORDER BY created_at
    LIMIT 1;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION
            'No organization matching Rainbow/RTG found. Refusing to guess — set v_org_id explicitly to the correct organizations.id and re-run.';
    END IF;

    INSERT INTO permissions (code, name, description, category) VALUES
        ('requests.multi_business_unit',
         'File for Multiple Business Units',
         'Choose which business unit a request is for, from the units an admin has assigned (in addition to their HRIMS home unit)',
         'requests')
    ON CONFLICT (code) DO NOTHING;

    INSERT INTO roles (organization_id, name, slug, description, color, is_system, is_default, priority)
    VALUES (v_org_id, 'Multi-Unit Requester', 'multi_unit_requester',
        'Works across more than one business unit. Picks which unit each request is for; the units are ticked per user in the User Access Manager.',
        'teal', true, false, 40)
    ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, priority = EXCLUDED.priority, updated_at = now()
    RETURNING id INTO v_role_id;

    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role_id, p.id FROM permissions p
    WHERE p.code IN (
        'requests.multi_business_unit',
        'requests.create',
        'requests.view_own',
        'requests.edit_own',
        'requests.withdraw',
        'archives.view_own',
        'archives.download'
    )
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- First holder: Takudzwa Mashayamombe — Azambezi River Lodge (HRIMS home
    -- unit) + Victoria Falls Rainbow Hotel. No-op if he has no account here.
    SELECT id INTO v_user_id
    FROM app_users
    WHERE organization_id = v_org_id AND email ILIKE 'takudzwa.mashayamombe@rtg.co.zw'
    LIMIT 1;

    IF v_user_id IS NOT NULL THEN
        INSERT INTO user_roles (user_id, role_id, is_active)
        SELECT v_user_id, v_role_id, true
        WHERE NOT EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = v_user_id AND role_id = v_role_id
              AND department_id IS NULL AND business_unit_id IS NULL
        );
        UPDATE user_roles SET is_active = true
        WHERE user_id = v_user_id AND role_id = v_role_id;

        INSERT INTO user_request_business_units (user_id, organization_id, business_unit_code, business_unit_name)
        VALUES
            (v_user_id, v_org_id, 'ARL', 'Azambezi River Lodge'),
            (v_user_id, v_org_id, 'VFH', 'Victoria Falls Rainbow Hotel')
        ON CONFLICT (user_id, business_unit_code) DO NOTHING;
    END IF;

    RAISE NOTICE 'Multi-Unit Requester role seeded: %', v_role_id;
END $$;
