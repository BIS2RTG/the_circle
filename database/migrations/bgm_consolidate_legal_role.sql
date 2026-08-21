-- ============================================================
-- Consolidate the Legal roles into ONE: "Legal Team Member"
-- ============================================================
-- Replaces the previous two-role split (Legal Super-Admin + Legal Team Member)
-- with a single legal role that holds EVERY legal permission plus the standard
-- employee / request permissions — so a legal user has full access to legal
-- information AND sees the Dashboard, Requests and E-Sign navigation (a legal
-- team member is also staff).
--
-- Must run AFTER all bgm_* permission migrations so category='legal' is complete.
-- Idempotent.
-- ============================================================

-- 1. legal_team_member gets ALL legal permissions.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.slug = 'legal_team_member' AND p.category = 'legal'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 2. legal_team_member also inherits the default employee permission set
--    (requests.create, requests.view_own, approvals.view, …) so the standard
--    staff navigation appears alongside Legal.
INSERT INTO role_permissions (role_id, permission_id)
SELECT lm.id, rp.permission_id
FROM roles lm
JOIN roles em ON em.organization_id = lm.organization_id AND em.slug = 'employee'
JOIN role_permissions rp ON rp.role_id = em.id
WHERE lm.slug = 'legal_team_member'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 3. Move every Legal Super-Admin holder onto Legal Team Member (skip anyone who
--    already has it), then drop the leftover Legal Super-Admin assignments.
UPDATE user_roles ur
SET role_id = lm.id
FROM roles lsa
JOIN roles lm ON lm.organization_id = lsa.organization_id AND lm.slug = 'legal_team_member'
WHERE lsa.slug = 'legal_super_admin'
  AND ur.role_id = lsa.id
  AND NOT EXISTS (SELECT 1 FROM user_roles u2 WHERE u2.user_id = ur.user_id AND u2.role_id = lm.id);

DELETE FROM user_roles ur USING roles lsa
WHERE lsa.slug = 'legal_super_admin' AND ur.role_id = lsa.id;

-- 4. Remove the Legal Super-Admin role entirely.
DELETE FROM role_permissions rp USING roles lsa
WHERE lsa.slug = 'legal_super_admin' AND rp.role_id = lsa.id;
DELETE FROM roles WHERE slug = 'legal_super_admin';

-- 4b. Remove other unused legal preset roles (only if they have no holders),
--     so the Legal module presents a single "Legal Team Member" role.
DELETE FROM role_permissions rp USING roles r
WHERE r.id = rp.role_id
  AND r.slug IN ('legal_viewer', 'legal_meetings', 'legal_directors')
  AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.id);
DELETE FROM roles r
WHERE r.slug IN ('legal_viewer', 'legal_meetings', 'legal_directors')
  AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.id);

-- 5. Refresh the surviving role's metadata.
UPDATE roles SET
  description = 'The Legal team role: full access to the Legal module — board governance, meetings, attendance, directors, committees, declarations, resolutions, the director portal and governance reports — plus the standard request, approval and e-signature tools.',
  color = 'amber',
  priority = 60,
  updated_at = now()
WHERE slug = 'legal_team_member';
