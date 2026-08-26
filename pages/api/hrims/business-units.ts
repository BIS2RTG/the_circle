import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { getBusinessUnits } from '@/lib/orgStructure';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);

    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const orgId = (session.user as any).org_id;
    const businessUnits = await getBusinessUnits(orgId);

    return res.status(200).json({ businessUnits, total: businessUnits.length });
  } catch (error: any) {
    console.error('HRIMS Business Units API error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch HRIMS business units' });
  }
}
