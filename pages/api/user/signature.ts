import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SIGNATURE_BUCKET, signatureExists, userSignaturePath, userSignatureProxyUrl } from '@/lib/signatureStorage';
import { audit } from '@/lib/auditLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);

  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = session.user.id;

  if (req.method === 'GET') {
    try {
      // Private bucket: check existence via the service role, return proxy URL.
      const exists = await signatureExists(userSignaturePath(userId));
      return res.status(200).json({ signature_url: exists ? userSignatureProxyUrl(userId) : null });
    } catch (error: any) {
      console.error('Signature fetch error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Server not configured' });
      }
      // Remove the stored object so the deletion actually persists — clearing
      // the UI alone left the old signature in storage, so it reappeared on the
      // next load (and could still be applied to approvals).
      const { error } = await supabaseAdmin.storage
        .from(SIGNATURE_BUCKET)
        .remove([userSignaturePath(userId)]);

      if (error) {
        console.error('Signature delete error:', error);
        return res.status(500).json({ error: error.message || 'Failed to delete signature' });
      }

      await audit(req, session.user, {
        category: 'security',
        action: 'security.signature_deleted',
        severity: 'notice',
        targetType: 'user',
        targetId: userId,
        details: { method: 'settings' },
      });

      return res.status(200).json({ ok: true });
    } catch (error: any) {
      console.error('Signature delete error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
