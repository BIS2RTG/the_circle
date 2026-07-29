-- ============================================================
-- BGM DEMO board members — STAGING / PREVIEW ONLY
-- ============================================================
-- Obviously-fake directors ("Demo Director N") so no real board member PII
-- lives in non-production environments, and so it's unmistakable this is demo
-- data. Mirrors the real committee shape (chairs + members) so the full
-- scheduling / invitation / attendance flow can be exercised.
--
-- Emails are placeholders (@demo.rtg.test). Edit a director's email via the
-- Legal UI to a real inbox when you want to test live invitation delivery.
--
-- Safe to re-run (idempotent). Requires create_bgm_tables.sql first.
-- ============================================================
DO $$
DECLARE v_org UUID;
BEGIN
    SELECT id INTO v_org FROM organizations WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%' LIMIT 1;
    IF v_org IS NULL THEN SELECT id INTO v_org FROM organizations LIMIT 1; END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'No organization found.'; END IF;

    INSERT INTO directors (organization_id, full_name, salutation, email) VALUES
        (v_org, 'Demo Director 1', NULL, 'demo.director1@demo.rtg.test'),
        (v_org, 'Demo Director 2', NULL, 'demo.director2@demo.rtg.test'),
        (v_org, 'Demo Director 3', NULL, 'demo.director3@demo.rtg.test'),
        (v_org, 'Demo Director 4', NULL, 'demo.director4@demo.rtg.test'),
        (v_org, 'Demo Director 5', NULL, 'demo.director5@demo.rtg.test'),
        (v_org, 'Demo Director 6', NULL, 'demo.director6@demo.rtg.test'),
        (v_org, 'Demo Director 7', NULL, 'demo.director7@demo.rtg.test'),
        (v_org, 'Demo Director 8', NULL, 'demo.director8@demo.rtg.test'),
        (v_org, 'Demo Director 9', NULL, 'demo.director9@demo.rtg.test')
    ON CONFLICT (organization_id, full_name) DO NOTHING;

    WITH seed(committee_slug, director_name, is_chair) AS (
        VALUES
            ('audit-risk-sustainability',   'Demo Director 1', true),
            ('audit-risk-sustainability',   'Demo Director 2', false),
            ('audit-risk-sustainability',   'Demo Director 3', false),
            ('strategy-growth-investments', 'Demo Director 4', true),
            ('strategy-growth-investments', 'Demo Director 3', false),
            ('strategy-growth-investments', 'Demo Director 5', false),
            ('strategy-growth-investments', 'Demo Director 6', false),
            ('commercial-operations',       'Demo Director 7', true),
            ('commercial-operations',       'Demo Director 8', false),
            ('commercial-operations',       'Demo Director 1', false),
            ('technology-business-reeng',   'Demo Director 8', true),
            ('technology-business-reeng',   'Demo Director 2', false),
            ('technology-business-reeng',   'Demo Director 9', false),
            ('hr-governance-nominations',   'Demo Director 6', true),
            ('hr-governance-nominations',   'Demo Director 5', false),
            ('hr-governance-nominations',   'Demo Director 7', false),
            ('main-board-agm',              'Demo Director 5', true),
            ('main-board-agm',              'Demo Director 1', false),
            ('main-board-agm',              'Demo Director 2', false),
            ('main-board-agm',              'Demo Director 3', false),
            ('main-board-agm',              'Demo Director 4', false),
            ('main-board-agm',              'Demo Director 6', false),
            ('main-board-agm',              'Demo Director 7', false),
            ('main-board-agm',              'Demo Director 8', false),
            ('main-board-agm',              'Demo Director 9', false)
    )
    INSERT INTO committee_memberships (committee_id, director_id, is_chair)
    SELECT c.id, d.id, s.is_chair
    FROM seed s
    JOIN committees c ON c.organization_id = v_org AND c.slug = s.committee_slug
    JOIN directors  d ON d.organization_id = v_org AND d.full_name = s.director_name
    ON CONFLICT (committee_id, director_id) DO UPDATE SET is_chair = EXCLUDED.is_chair;

    RAISE NOTICE 'BGM DEMO board seeded for org %', v_org;
END $$;
