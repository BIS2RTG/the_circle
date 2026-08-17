/**
 * Application-level Microsoft Graph mail (client-credentials).
 *
 * Sends system-generated email (e.g. OTP codes) from a dedicated service
 * mailbox using the app's own identity — NOT the signed-in user. This keeps
 * the message out of any user's Sent Items, which matters for OTPs the sender
 * must not be able to read.
 *
 * Requirements (all Microsoft-native, no third party):
 *   - Azure AD app (already used for sign-in): AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT
 *   - Graph **application** permission `Mail.Send` granted with admin consent
 *   - GRAPH_MAIL_SENDER = the UPN/email of the mailbox to send from
 *
 * Degrades gracefully: if not configured it returns { success:false } instead
 * of throwing, so callers (OTP flow) never 500.
 */

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
let cached: CachedToken | null = null;

/**
 * The mailbox all system/notification email is sent FROM. Notifications must
 * appear to come from The Circle's own address — never from the individual
 * approver/requester who happened to trigger them. Overridable via
 * GRAPH_MAIL_SENDER, but defaults to the service mailbox so a missing env var
 * can't silently flip the sender back to an individual's delegated mailbox.
 */
export const DEFAULT_MAIL_SENDER = 'thecircle@rtg.co.zw';

export function graphMailSender(): string {
  return process.env.GRAPH_MAIL_SENDER || DEFAULT_MAIL_SENDER;
}

export function isGraphAppMailConfigured(): boolean {
  // The sender is always defaulted (DEFAULT_MAIL_SENDER), so configuration comes
  // down to having the Azure app credentials for the client-credentials grant.
  // Application Mail.Send admin consent is still required for the send to
  // actually succeed; when it isn't granted the send returns { success:false }
  // and the caller falls through to the next transport.
  return !!(
    process.env.AZURE_CLIENT_ID &&
    process.env.AZURE_CLIENT_SECRET &&
    process.env.AZURE_TENANT
  );
}

export async function getAppToken(): Promise<string | null> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET || !process.env.AZURE_TENANT) {
    return null;
  }

  const tenant = process.env.AZURE_TENANT;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const resp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('graphAppMail: token request failed:', resp.status, text);
    return null;
  }
  const json: any = await resp.json();
  if (!json.access_token) return null;
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000),
  };
  return cached.token;
}

export interface AppMailAttachment {
  /** File name as it should appear in the email. */
  name: string;
  contentType: string;
  /** Raw file bytes. */
  content: Buffer;
}

export interface SendAppMailOptions {
  to: string;
  subject: string;
  html: string;
  /** Override the sender mailbox (defaults to GRAPH_MAIL_SENDER). */
  sender?: string;
  /** Optional file attachments (e.g. the approved request PDF). */
  attachments?: AppMailAttachment[];
}

export async function sendAppGraphMail(
  opts: SendAppMailOptions
): Promise<{ success: boolean; error?: string }> {
  const sender = opts.sender || graphMailSender();

  const token = await getAppToken();
  if (!token) return { success: false, error: 'Could not acquire Graph app token' };

  const message: Record<string, any> = {
    subject: opts.subject,
    body: { contentType: 'HTML', content: opts.html },
    toRecipients: [{ emailAddress: { address: opts.to } }],
  };

  if (opts.attachments?.length) {
    message.attachments = opts.attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType,
      contentBytes: a.content.toString('base64'),
    }));
  }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // System mail — don't keep a copy in the service mailbox's Sent Items.
      body: JSON.stringify({ message, saveToSentItems: false }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('graphAppMail: sendMail failed:', resp.status, text);
    return { success: false, error: `Graph sendMail failed (${resp.status})` };
  }
  return { success: true };
}
