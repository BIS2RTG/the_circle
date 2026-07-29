import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { guardAuditApi } from '@/lib/auditAccess';

/**
 * Notification & email delivery log for a single request, for the
 * audit/transactions deep-dive. Merges two sources into one timeline:
 *
 *   - EMAILS: notification_deliveries (one row per attempt, incl. drops)
 *   - IN-APP: notifications addressed about this request (metadata.request_id)
 *
 * Auditor role / audit permissions only (same gate as the rest of /api/audit).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const guard = await guardAuditApi(req, res);
  if (!guard) return; // guard already wrote the response

  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
  if (!requestId) {
    return res.status(400).json({ error: 'requestId is required' });
  }

  try {
    const [emailsRes, inAppRes] = await Promise.all([
      supabaseAdmin
        .from('notification_deliveries')
        .select(
          `id, created_at, channel, kind, subject, transport, success, reason,
           recipient_email, recipient:app_users!notification_deliveries_recipient_id_fkey ( id, display_name, email )`
        )
        .eq('request_id', requestId)
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('notifications')
        .select(
          `id, created_at, type, title, message, is_read, metadata,
           recipient:app_users!notifications_recipient_id_fkey ( id, display_name, email )`
        )
        .eq('metadata->>request_id', requestId)
        .order('created_at', { ascending: false }),
    ]);

    if (emailsRes.error) throw emailsRes.error;
    if (inAppRes.error) throw inAppRes.error;

    const emails = (emailsRes.data || []).map((r: any) => {
      const recipient = Array.isArray(r.recipient) ? r.recipient[0] : r.recipient;
      return {
        id: r.id,
        channel: 'email' as const,
        at: r.created_at,
        kind: r.kind,
        subject: r.subject,
        transport: r.transport,
        success: r.success,
        reason: r.reason,
        recipientName: recipient?.display_name || recipient?.email || r.recipient_email || 'Unknown',
        recipientEmail: recipient?.email || r.recipient_email || null,
      };
    });

    const inApp = (inAppRes.data || []).map((r: any) => {
      const recipient = Array.isArray(r.recipient) ? r.recipient[0] : r.recipient;
      return {
        id: r.id,
        channel: 'in_app' as const,
        at: r.created_at,
        kind: r.type,
        subject: r.title,
        message: r.message,
        isRead: r.is_read,
        // A fan-out copy to an assistant is tagged in metadata.
        onBehalfOf: r.metadata?.on_behalf_of || null,
        recipientName: recipient?.display_name || recipient?.email || 'Unknown',
        recipientEmail: recipient?.email || null,
      };
    });

    const timeline = [...emails, ...inApp].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
    );

    return res.status(200).json({
      requestId,
      counts: {
        emails: emails.length,
        emailsDelivered: emails.filter((e) => e.success).length,
        inApp: inApp.length,
      },
      timeline,
    });
  } catch (err: any) {
    console.error('deliveries API error:', err);
    return res.status(500).json({ error: err.message || 'Failed to load delivery log' });
  }
}
