/**
 * Preference-gated email delivery for workflow notifications.
 *
 * One entry point — sendUserNotificationEmail — that:
 *   1. Looks up the recipient's user_preferences and drops the email when the
 *      matching toggle is off.
 *   2. Sends via Microsoft Graph app mail (service mailbox) when configured,
 *      falling back to Resend, and logs (never throws) when neither transport
 *      is available. Workflow actions must never fail because of email.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { sendAppGraphMail, isGraphAppMailConfigured, AppMailAttachment } from './graphAppMail';
import { sendEmail as sendResendEmail } from './email';
import { sendGraphMail } from './graphMail';
import { getValidMsAccessToken, getAnyValidDelegatedSenderId } from './msTokenStore';
import { appBaseUrl, emailLogoUrl, brandedEmailShell } from './emailShell';
import { getUserPreferences, UserPreferences } from './userPreferences';

export type NotificationEmailKind =
  | 'request_updates'   // review progress on my own requests
  | 'approval_tasks'    // a request needs my approval
  | 'completion'        // final approval + signed PDF
  | 'reminder'          // pending approval nudges
  | 'digest';           // weekly summary

const KIND_TO_PREF: Record<NotificationEmailKind, keyof UserPreferences> = {
  request_updates: 'emailRequestUpdates',
  approval_tasks: 'emailApprovalTasks',
  completion: 'emailCompletionPdf',
  reminder: 'approvalReminders',
  digest: 'weeklyDigest',
};

// Re-export the shared shell helpers so existing importers of this module
// (approvalEngine, crons) keep working unchanged.
export { appBaseUrl, emailLogoUrl, brandedEmailShell };

/** Branded shell shared by all notification emails. */
export function notificationEmailHtml(params: {
  heading: string;
  bodyHtml: string;
  actionUrl?: string | null;
  actionLabel?: string | null;
}): string {
  return brandedEmailShell(params);
}

async function resolveRecipient(userId?: string | null, email?: string | null): Promise<string | null> {
  if (email) return email;
  if (!userId) return null;
  const { data } = await supabaseAdmin
    .from('app_users')
    .select('email')
    .eq('id', userId)
    .single();
  return data?.email || null;
}

/** Pull a request id out of an in-app path like `/requests/<uuid>` (or /comp/). */
function requestIdFromActionUrl(actionUrl?: string | null): string | null {
  if (!actionUrl) return null;
  const m = actionUrl.match(
    /\/requests(?:\/comp)?\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return m ? m[1] : null;
}

/**
 * Append one row to notification_deliveries for an email attempt — success or
 * drop. Best-effort: audit logging must never break the notification path.
 */
async function recordEmailDelivery(row: {
  requestId: string | null;
  recipientId?: string | null;
  recipientEmail: string | null;
  kind: NotificationEmailKind;
  subject: string;
  success: boolean;
  reason?: string | null;
  actorId?: string | null;
}): Promise<void> {
  try {
    let organizationId: string | null = null;
    if (row.recipientId) {
      const { data } = await supabaseAdmin
        .from('app_users')
        .select('organization_id')
        .eq('id', row.recipientId)
        .maybeSingle();
      organizationId = data?.organization_id || null;
    }
    await supabaseAdmin.from('notification_deliveries').insert({
      organization_id: organizationId,
      request_id: row.requestId,
      recipient_id: row.recipientId || null,
      recipient_email: row.recipientEmail,
      channel: 'email',
      kind: row.kind,
      subject: row.subject,
      transport: row.success ? row.reason || null : null,
      success: row.success,
      reason: row.reason || null,
      actor_id: row.actorId || null,
    });
  } catch (e) {
    console.warn('recordEmailDelivery failed (non-fatal):', e);
  }
}

/**
 * Send a workflow notification email, honouring the recipient's preferences.
 * Returns { sent:false } (never throws) when the toggle is off or no email
 * transport is configured.
 */
export async function sendUserNotificationEmail(params: {
  /** Recipient app_users id — used for the preference check and email lookup. */
  userId: string;
  /** Skip the app_users lookup when the caller already has the address. */
  email?: string | null;
  kind: NotificationEmailKind;
  subject: string;
  heading: string;
  /** Plain text or simple HTML body (rendered inside the branded shell). */
  bodyHtml: string;
  /** In-app path (e.g. /requests/abc) or absolute URL for the CTA button. */
  actionUrl?: string | null;
  actionLabel?: string | null;
  attachments?: AppMailAttachment[];
  /**
   * The user who triggered this notification (the approver who acted, the
   * requester who submitted, the admin who created a delegation…). Used as the
   * delegated sender when neither the service mailbox nor Resend is configured,
   * so notifications still deliver in environments that only have the same
   * delegated Graph access the e-sign flow uses. Falls back to the recipient's
   * own token (e.g. cron reminders, which have no actor).
   */
  actorUserId?: string | null;
  /**
   * The request this notification concerns, for the audit/transactions
   * delivery log. When omitted it's inferred from `actionUrl` (e.g.
   * /requests/<id>). Pass explicitly when the CTA doesn't point at the request.
   */
  requestId?: string | null;
}): Promise<{ sent: boolean; reason?: string }> {
  const requestId = params.requestId || requestIdFromActionUrl(params.actionUrl);
  try {
    const prefs = await getUserPreferences(params.userId);
    if (!prefs[KIND_TO_PREF[params.kind]]) {
      await recordEmailDelivery({
        requestId, recipientId: params.userId, recipientEmail: params.email || null,
        kind: params.kind, subject: params.subject, success: false,
        reason: 'preference_off', actorId: params.actorUserId,
      });
      return { sent: false, reason: 'preference_off' };
    }

    const to = await resolveRecipient(params.userId, params.email);
    if (!to) {
      await recordEmailDelivery({
        requestId, recipientId: params.userId, recipientEmail: null,
        kind: params.kind, subject: params.subject, success: false,
        reason: 'no_email', actorId: params.actorUserId,
      });
      return { sent: false, reason: 'no_email' };
    }

    // The recipient's organisation — used for the org-relay fallback below so
    // we only ever borrow a mailbox belonging to the same organisation.
    let organizationId: string | null = null;
    {
      const { data: recipientRow } = await supabaseAdmin
        .from('app_users')
        .select('organization_id')
        .eq('id', params.userId)
        .maybeSingle();
      organizationId = recipientRow?.organization_id || null;
    }

    const actionUrl = params.actionUrl
      ? params.actionUrl.startsWith('http')
        ? params.actionUrl
        : `${appBaseUrl()}${params.actionUrl}`
      : null;

    const html = notificationEmailHtml({
      heading: params.heading,
      bodyHtml: params.bodyHtml,
      actionUrl,
      actionLabel: params.actionLabel,
    });

    // Transport chain, most-preferred-first.
    //
    // The SERVICE MAILBOX (application Graph mail from thecircle@rtg.co.zw) is
    // the primary transport: every notification should appear to come from The
    // Circle, not from the individual approver/requester who triggered it. It
    // requires application Mail.Send admin consent — until that's granted the
    // send returns success:false and we fall through to the delegated transports
    // below (which send from an individual's mailbox) so email still delivers.
    // Once consent is in place the service mailbox wins every time and the
    // delegated/relay fallbacks are never reached.
    type Attempt = { label: string; run: () => Promise<boolean> };
    const attempts: Attempt[] = [];

    const delegatedAttempt = (senderId: string, label: string): Attempt => ({
      label,
      run: async () => {
        const token = await getValidMsAccessToken(senderId);
        if (!token) return false;
        await sendGraphMail({
          accessToken: token,
          to: { email: to },
          subject: params.subject,
          html,
          // System notifications shouldn't clutter the sender's Sent Items.
          saveToSentItems: false,
        });
        return true;
      },
    });

    // 1. Service mailbox — the canonical "from The Circle" sender.
    if (isGraphAppMailConfigured()) {
      attempts.push({
        label: 'graph_app_mail',
        run: async () =>
          (await sendAppGraphMail({ to, subject: params.subject, html, attachments: params.attachments })).success,
      });
    }
    // 2. Resend — also a non-individual, domain-level sender.
    if (process.env.RESEND_API_KEY) {
      attempts.push({
        label: 'resend',
        run: async () => !!(await sendResendEmail({ to, subject: params.subject, html })).success,
      });
    }
    // 3+. Delegated fallbacks (send from an individual's mailbox). Only reached
    // when the service mailbox isn't available — kept so notifications still
    // deliver in environments without application Mail.Send consent.
    if (params.actorUserId) {
      attempts.push(delegatedAttempt(params.actorUserId, 'graph_delegated_actor'));
    }
    if (params.userId && params.userId !== params.actorUserId) {
      attempts.push(delegatedAttempt(params.userId, 'graph_delegated_recipient'));
    }
    // Last-resort org relay: when neither the actor nor the recipient has a
    // connected mailbox (most users never connect Microsoft), borrow ANY
    // connected mailbox in the recipient's organisation. This is what stops
    // approval emails from silently dropping once a workflow reaches a
    // token-less approver — e.g. the final CAPEX sign-offs never getting
    // notified because the approver before them hadn't connected Microsoft.
    attempts.push({
      label: 'graph_delegated_org_relay',
      run: async () => {
        const senderId = await getAnyValidDelegatedSenderId(organizationId, [
          params.actorUserId,
          params.userId,
        ]);
        if (!senderId) return false;
        const token = await getValidMsAccessToken(senderId);
        if (!token) return false;
        await sendGraphMail({
          accessToken: token,
          to: { email: to },
          subject: params.subject,
          html,
          saveToSentItems: false,
        });
        return true;
      },
    });

    for (const attempt of attempts) {
      try {
        if (await attempt.run()) {
          await recordEmailDelivery({
            requestId, recipientId: params.userId, recipientEmail: to,
            kind: params.kind, subject: params.subject, success: true,
            reason: attempt.label, actorId: params.actorUserId,
          });
          return { sent: true, reason: attempt.label };
        }
        console.warn(`notificationEmail: transport ${attempt.label} did not deliver to ${to}`);
      } catch (e: any) {
        console.warn(`notificationEmail: transport ${attempt.label} threw for ${to}:`, e?.message || e);
      }
    }

    console.warn(
      `notificationEmail: all transports failed for ${to} (tried: ${attempts.map((a) => a.label).join(', ') || 'none'}). ` +
        'Need a delegated Graph token for the actor/recipient, GRAPH_MAIL_SENDER (+ application Mail.Send admin consent), or RESEND_API_KEY.'
    );
    await recordEmailDelivery({
      requestId, recipientId: params.userId, recipientEmail: to,
      kind: params.kind, subject: params.subject, success: false,
      reason: 'not_configured', actorId: params.actorUserId,
    });
    return { sent: false, reason: 'not_configured' };
  } catch (e: any) {
    console.error('notificationEmail: send threw (non-fatal):', e);
    await recordEmailDelivery({
      requestId, recipientId: params.userId, recipientEmail: params.email || null,
      kind: params.kind, subject: params.subject, success: false,
      reason: e?.message || 'error', actorId: params.actorUserId,
    });
    return { sent: false, reason: e?.message || 'error' };
  }
}

/** Escape user-supplied text before interpolating into email HTML. */
export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
