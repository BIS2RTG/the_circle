-- Seed business units for Rainbow Tourism Group
-- NOTE: Replace 'YOUR_RTG_ORGANIZATION_ID' with the actual organization_id for Rainbow Tourism Group
-- You can find this by running: SELECT id, name FROM organizations WHERE name = 'Rainbow Tourism Group';

-- Insert business units for Rainbow Tourism Group
INSERT INTO business_units (organization_id, name) VALUES
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'RTG Head Office'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Corporate Office'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Gateway Stream'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Rainbow Towers Hotel'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Bulawayo Rainbow Hotel'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'New Ambassador Hotel'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'RTG South Africa'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Kadoma Rainbow Hotel and Conference Centre'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Heritage Expeditions Africa'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Azambezi River Lodge'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Victoria Falls Rainbow Hotel'),
  ((SELECT id FROM organizations WHERE name = 'Rainbow Tourism Group' LIMIT 1), 'Montclair Resort and Conference')
ON CONFLICT (organization_id, name) DO NOTHING;
