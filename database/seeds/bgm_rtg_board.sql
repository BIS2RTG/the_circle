-- ============================================================
-- BGM REAL RTG board & committee compositions — PRODUCTION ONLY
-- ============================================================
-- The actual RTG board and its committee compositions (chairs + members).
-- Apply ONLY to the production database, and only if the legal team prefers a
-- one-shot seed over entering directors through the UI. Do NOT apply to
-- staging/preview (use bgm_demo_board.sql there — staging must keep obviously
-- fictional names). Emails are captured by Legal afterwards, or the legal team
-- adds/removes members via /legal/board → Committees.
--
-- Two people appear with different titles across committees in the source
-- table; canonicalised here to a single record each:
--   * Givemore Taputaira → "Dr. Givemore Taputaira"
--   * Langton Mabhanga   → "Dr. Langton Mabhanga"
--
-- Idempotent. Requires create_bgm_tables.sql first.
-- ============================================================
DO $$
DECLARE v_org UUID;
BEGIN
    SELECT id INTO v_org FROM organizations WHERE name ILIKE '%rainbow%' OR name ILIKE '%RTG%' LIMIT 1;
    IF v_org IS NULL THEN SELECT id INTO v_org FROM organizations LIMIT 1; END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'No organization found.'; END IF;

    -- Directors (all people who chair or sit on a committee).
    INSERT INTO directors (organization_id, full_name, salutation) VALUES
        (v_org, 'Mr. Kenzias Chibota',      'Mr.'),
        (v_org, 'Dr. Givemore Taputaira',   'Dr.'),
        (v_org, 'Mrs. Chipo Mafunga',       'Mrs.'),
        (v_org, 'Mr. Samson Chitsato',      'Mr.'),
        (v_org, 'Mr. Tapiwa Mari',          'Mr.'),
        (v_org, 'Mr. Tendai Madziwanyika',  'Mr.'),
        (v_org, 'Mr. Kumbirai Gundani',     'Mr.'),
        (v_org, 'Mr. Douglas Hoto',         'Mr.'),
        (v_org, 'Mr. Douglas Mavhembu',     'Mr.'),
        (v_org, 'Dr. Langton Mabhanga',     'Dr.'),
        (v_org, 'Mrs. Cynthia Malaba',      'Mrs.'),
        (v_org, 'Mr. Shupai Marware',       'Mr.'),
        (v_org, 'Mr. Andrew Bvumbe',        'Mr.'),
        (v_org, 'Mr. Kilford Runhare',      'Mr.'),
        (v_org, 'Mr. Edwin Ruzive',         'Mr.'),
        (v_org, 'Mr. Lawrence Dhemba',      'Mr.')
    ON CONFLICT (organization_id, full_name) DO NOTHING;

    WITH seed(committee_slug, director_name, is_chair) AS (
        VALUES
            -- Audit, Risk and Sustainability
            ('audit-risk-sustainability',   'Mr. Kenzias Chibota',     true),
            ('audit-risk-sustainability',   'Dr. Givemore Taputaira',  false),
            ('audit-risk-sustainability',   'Mrs. Chipo Mafunga',      false),
            ('audit-risk-sustainability',   'Mr. Samson Chitsato',     false),
            ('audit-risk-sustainability',   'Mr. Tapiwa Mari',         false),
            ('audit-risk-sustainability',   'Mr. Tendai Madziwanyika', false),
            -- Strategy, Growth and Investments
            ('strategy-growth-investments', 'Mr. Kumbirai Gundani',    true),
            ('strategy-growth-investments', 'Mrs. Chipo Mafunga',      false),
            ('strategy-growth-investments', 'Mr. Douglas Hoto',        false),
            ('strategy-growth-investments', 'Mr. Douglas Mavhembu',    false),
            ('strategy-growth-investments', 'Mr. Tapiwa Mari',         false),
            ('strategy-growth-investments', 'Mr. Tendai Madziwanyika', false),
            -- Commercial and Operations
            ('commercial-operations',       'Dr. Langton Mabhanga',    true),
            ('commercial-operations',       'Mrs. Cynthia Malaba',     false),
            ('commercial-operations',       'Mr. Kenzias Chibota',     false),
            ('commercial-operations',       'Mr. Shupai Marware',      false),
            ('commercial-operations',       'Mr. Tapiwa Mari',         false),
            ('commercial-operations',       'Mr. Tendai Madziwanyika', false),
            -- Technology & Business Reengineering
            ('technology-business-reeng',   'Mrs. Cynthia Malaba',     true),
            ('technology-business-reeng',   'Dr. Givemore Taputaira',  false),
            ('technology-business-reeng',   'Mr. Andrew Bvumbe',       false),
            ('technology-business-reeng',   'Mr. Kilford Runhare',     false),
            ('technology-business-reeng',   'Mr. Edwin Ruzive',        false),
            ('technology-business-reeng',   'Mr. Tapiwa Mari',         false),
            ('technology-business-reeng',   'Mr. Tendai Madziwanyika', false),
            -- Human Resources Governance and Nominations
            ('hr-governance-nominations',   'Mr. Douglas Mavhembu',    true),
            ('hr-governance-nominations',   'Mr. Douglas Hoto',        false),
            ('hr-governance-nominations',   'Dr. Langton Mabhanga',    false),
            ('hr-governance-nominations',   'Mr. Lawrence Dhemba',     false),
            ('hr-governance-nominations',   'Mr. Tapiwa Mari',         false),
            ('hr-governance-nominations',   'Mr. Tendai Madziwanyika', false),
            -- Main Board and AGM (all members; chaired by Mr. Douglas Hoto)
            ('main-board-agm',              'Mr. Douglas Hoto',        true),
            ('main-board-agm',              'Mr. Kenzias Chibota',     false),
            ('main-board-agm',              'Dr. Givemore Taputaira',  false),
            ('main-board-agm',              'Mrs. Chipo Mafunga',      false),
            ('main-board-agm',              'Mr. Samson Chitsato',     false),
            ('main-board-agm',              'Mr. Tapiwa Mari',         false),
            ('main-board-agm',              'Mr. Tendai Madziwanyika', false),
            ('main-board-agm',              'Mr. Kumbirai Gundani',    false),
            ('main-board-agm',              'Mr. Douglas Mavhembu',    false),
            ('main-board-agm',              'Dr. Langton Mabhanga',    false),
            ('main-board-agm',              'Mrs. Cynthia Malaba',     false),
            ('main-board-agm',              'Mr. Shupai Marware',      false),
            ('main-board-agm',              'Mr. Andrew Bvumbe',       false),
            ('main-board-agm',              'Mr. Kilford Runhare',     false),
            ('main-board-agm',              'Mr. Edwin Ruzive',        false),
            ('main-board-agm',              'Mr. Lawrence Dhemba',     false)
    )
    INSERT INTO committee_memberships (committee_id, director_id, is_chair)
    SELECT c.id, d.id, s.is_chair
    FROM seed s
    JOIN committees c ON c.organization_id = v_org AND c.slug = s.committee_slug
    JOIN directors  d ON d.organization_id = v_org AND d.full_name = s.director_name
    ON CONFLICT (committee_id, director_id) DO UPDATE SET is_chair = EXCLUDED.is_chair;

    RAISE NOTICE 'BGM REAL RTG board + committees seeded for org %', v_org;
END $$;
