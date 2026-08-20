-- ============================================================
-- BGM REAL RTG board members — PRODUCTION ONLY
-- ============================================================
-- The actual RTG board (Legal SRS v2.0, §2). Apply ONLY to the production
-- database, and only if the legal team prefers a one-shot seed over entering
-- directors through the UI. Do NOT apply to staging/preview (use
-- bgm_demo_board.sql there). Emails are captured by Legal afterwards.
--
-- Idempotent. Requires create_bgm_tables.sql first.
-- ============================================================
DO $$
DECLARE v_org UUID;
BEGIN
    SELECT id INTO v_org FROM organizations WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%' LIMIT 1;
    IF v_org IS NULL THEN SELECT id INTO v_org FROM organizations LIMIT 1; END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'No organization found.'; END IF;

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

    WITH seed(committee_slug, director_name, is_chair) AS (
        VALUES
            ('audit-risk-sustainability',   'Mr. Kenzias Chibota',  true),
            ('audit-risk-sustainability',   'Dr. G. Taputaira',     false),
            ('audit-risk-sustainability',   'Mrs. C. Mafunga',      false),
            ('strategy-growth-investments', 'Mr. Kumbirai Gundani', true),
            ('strategy-growth-investments', 'Mrs. C. Mafunga',      false),
            ('strategy-growth-investments', 'Mr. Douglas Hoto',     false),
            ('strategy-growth-investments', 'Mr. Douglas Mavhembu', false),
            ('commercial-operations',       'Dr. Langton Mabhanga', true),
            ('commercial-operations',       'Mrs. Cynthia Malaba',  false),
            ('commercial-operations',       'Mr. Kenzias Chibota',  false),
            ('technology-business-reeng',   'Mrs. Cynthia Malaba',  true),
            ('technology-business-reeng',   'Dr. G. Taputaira',     false),
            ('technology-business-reeng',   'Mr. A. Bvumbe',        false),
            ('hr-governance-nominations',   'Mr. Douglas Mavhembu', true),
            ('hr-governance-nominations',   'Mr. Douglas Hoto',     false),
            ('hr-governance-nominations',   'Dr. Langton Mabhanga', false),
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

    RAISE NOTICE 'BGM REAL RTG board seeded for org %', v_org;
END $$;
