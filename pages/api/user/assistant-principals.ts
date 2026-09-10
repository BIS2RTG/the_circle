import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { getPrincipalsForAssistant } from '@/lib/assistantAssignments';
import { canFileOnBehalfOfAnyone } from '@/lib/onBehalf';

/**
 * Who the signed-in user may file requests on behalf of.
 *
 *  - `principals` — the specific people an admin assigned them to assist.
 *  - `canFileForAnyone` — the HR-admin right, which lets them search the whole
 *    directory and name external guests instead of picking from that list.
 *
 * Powers the "Filing on behalf of" field, which hides itself when there is
 * neither a principal nor the broader right.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = session.user as any;
  const organizationId = user.org_id;
  if (!organizationId) return res.status(400).json({ error: 'No organization found' });

  const [principals, canFileForAnyone] = await Promise.all([
    getPrincipalsForAssistant(user.id, organizationId),
    canFileOnBehalfOfAnyone(user.id),
  ]);
  return res.status(200).json({ principals, canFileForAnyone });
}
