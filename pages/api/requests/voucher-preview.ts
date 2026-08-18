import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { generateVoucherHtml } from './[id]/voucher-pdf';

/**
 * Pre-submission voucher preview.
 *
 * Renders the SAME complimentary-voucher document that /api/requests/[id]/
 * voucher-pdf produces post-approval, but from the metadata POSTed by the new
 * voucher form — so a requester can see exactly what the voucher will look like
 * before submitting. It never touches the database and issues no voucher number.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const metadata = req.body?.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return res.status(400).json({ error: 'metadata is required' });
    }

    const user = session.user as any;

    // Synthetic, un-persisted request. No approval steps yet, so signatures are
    // blank and the approval date falls back to today (expiry = +3 months) —
    // exactly what a not-yet-approved voucher should preview as.
    const previewRequest = {
      id: 'PREVIEW00-0000-0000',
      title: metadata.guestNames ? `Voucher Request: ${metadata.guestNames}` : 'Voucher Request',
      description: metadata.reason || '',
      status: 'preview',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      creator: {
        display_name: user.display_name || user.name || '',
        email: user.email || '',
        job_title: user.job_title || '',
      },
      request_steps: [],
      metadata: { ...metadata, __preview: true },
    };

    const html = generateVoucherHtml(previewRequest);

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="voucher-preview.html"');
    return res.status(200).send(html);
  } catch (error: any) {
    console.error('Voucher preview error:', error);
    return res.status(500).json({ error: error.message || 'Failed to build voucher preview' });
  }
}
