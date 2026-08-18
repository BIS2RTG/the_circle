import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { ApprovalEngine } from '@/lib/approvalEngine';

/**
 * POST /api/approvals/screen
 *
 * A gatekeeping assistant screens an incoming approval before it reaches the
 * boss and either:
 *   - forwards it to the boss (the request continues its normal flow), or
 *   - returns it to the requestor's Drafts with a comment for changes.
 *
 * The authorisation (the caller must gatekeep the step's approver, and the step
 * must still be awaiting screening) is enforced inside the engine methods.
 *
 * Body: { requestId, stepId, action: 'forward' | 'return', comment? }
 * `return` requires a non-empty comment.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = (session.user as any).id;

  const requestId = req.body?.requestId;
  const stepId = req.body?.stepId;
  const action = req.body?.action;
  const comment = typeof req.body?.comment === 'string' ? req.body.comment : '';

  if (!requestId || !stepId || typeof requestId !== 'string' || typeof stepId !== 'string') {
    return res.status(400).json({ error: 'requestId and stepId are required' });
  }
  if (action !== 'forward' && action !== 'return') {
    return res.status(400).json({ error: "action must be 'forward' or 'return'" });
  }

  try {
    const result =
      action === 'forward'
        ? await ApprovalEngine.forwardScreenedStep(requestId, stepId, userId, comment)
        : await ApprovalEngine.returnScreenedRequest(requestId, stepId, userId, comment);

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to screen request' });
    }
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Screen request error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
