import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { getBusinessUnits } from '../../../lib/orgStructure';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerSession(req, res, authOptions);

    if (!session || !session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.method === 'GET') {
      // Business units to exclude from the list
      const excludedUnits = [
        'Gateway Stream',
        'Heritage Expeditions Africa',
        'Corporate Office',
        'RTG Head Office'
      ];

      // Fetch business units from HRIMS, falling back to the Circle DB's local
      // table when HRIMS isn't configured (e.g. the legal/staging environment).
      const orgId = (session.user as any).org_id;
      const businessUnits = await getBusinessUnits(orgId);

      // Filter out excluded business units. We pass `code` through too so
      // the client can match a HRIMS unit to the corresponding travel-auth
      // location dropdown entry directly (codes are stable, names aren't).
      const filteredData = businessUnits
        .filter((unit) => !excludedUnits.includes(unit.name))
        .map((unit) => ({ id: unit.id, name: unit.name, code: unit.code }));

      return res.status(200).json({ businessUnits: filteredData });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Business units API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
