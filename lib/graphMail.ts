/**
 * Microsoft Graph mail helper.
 *
 * Sends email *as the signed-in user* using a delegated access token captured
 * by NextAuth (see pages/api/auth/[...nextauth].ts). The token must include
 * the Mail.Send scope. With this approach the message appears in the user's
 * own Outlook Sent Items and is delivered from their real M365 mailbox —
 * no shared "noreply" mailbox required.
 */

import { brandedEmailShell } from './emailShell';

export interface GraphMailRecipient {
  email: string;
  name?: string;
}

export interface SendGraphMailOptions {
  accessToken: string;
  to: GraphMailRecipient | GraphMailRecipient[];
  cc?: GraphMailRecipient[];
  bcc?: GraphMailRecipient[];
  subject: string;
  html: string;
  /** Save a copy in the sender's Sent Items (default: true). */
  saveToSentItems?: boolean;
  /**
   * Override the visible From/Sender. Requires the token owner to have "Send As"
   * (or Send on Behalf) rights on that mailbox — used to make notifications
   * appear to come from the shared service mailbox even when delivered via an
   * individual's delegated token. Graph rejects with ErrorSendAsDenied when the
   * right isn't granted, so callers should be prepared to retry without it.
   */
  from?: GraphMailRecipient;
}

function toRecipientList(
  r: GraphMailRecipient | GraphMailRecipient[]
): Array<{ emailAddress: { address: string; name?: string } }> {
  const arr = Array.isArray(r) ? r : [r];
  return arr.map((x) => ({
    emailAddress: { address: x.email, name: x.name },
  }));
}

/**
 * Send an HTML email via Microsoft Graph /me/sendMail. Throws on failure.
 * Returns nothing on success (Graph returns 202 Accepted with no body).
 */
export async function sendGraphMail(opts: SendGraphMailOptions): Promise<void> {
  const {
    accessToken,
    to,
    cc,
    bcc,
    subject,
    html,
    saveToSentItems = true,
    from,
  } = opts;

  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: toRecipientList(to),
  };
  if (cc?.length) message.ccRecipients = toRecipientList(cc);
  if (bcc?.length) message.bccRecipients = toRecipientList(bcc);
  if (from) {
    message.from = { emailAddress: { address: from.email, name: from.name } };
  }

  const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, saveToSentItems }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Microsoft Graph sendMail failed (${resp.status}): ${text || resp.statusText}`
    );
  }
}

/**
 * Branded HTML template for an "invitation to sign" email. The signing link
 * points at /esign/sign/[token] in the current deployment.
 */
export function getSignInviteEmailHtml(params: {
  signerName?: string;
  requesterName: string;
  documentName: string;
  signingUrl: string;
  message?: string;
  expiresInDays?: number;
}): string {
  const {
    signerName,
    requesterName,
    documentName,
    signingUrl,
    message,
    expiresInDays = 30,
  } = params;

  const greeting = signerName ? `Hi ${escapeHtml(signerName)},` : "Hello,";
  const messageBlock = message
    ? `
      <table role="presentation" style="width:100%;background-color:#f7f2ea;border-left:4px solid #9A7545;border-radius:8px;margin:22px 0">
        <tr><td style="padding:16px 20px">
          <p style="margin:0 0 6px;color:#8a8279;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Personal message</p>
          <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(message)}</p>
        </td></tr>
      </table>`
    : "";

  return brandedEmailShell({
    heading: "You have a document to sign",
    preheader: `${escapeHtml(requesterName)} invited you to sign “${escapeHtml(documentName)}”.`,
    bodyHtml: `
      <p style="margin:0 0 16px">${greeting}</p>
      <p style="margin:0 0 18px"><strong>${escapeHtml(requesterName)}</strong> has invited you to electronically sign the document <strong>“${escapeHtml(documentName)}”</strong>.</p>
      ${messageBlock}
      <table role="presentation" style="width:100%;background:#f7f2ea;border:1px solid #eadfce;border-radius:8px;margin:20px 0">
        <tr><td style="padding:13px 16px;color:#8a6d3b;font-size:13px;line-height:1.5">
          This signing link expires in <strong>${expiresInDays} days</strong>.
        </td></tr>
      </table>
      <p style="margin:18px 0 4px;color:#6b7280;font-size:13px">If the button doesn’t work, copy and paste this link into your browser:</p>
      <p style="margin:0;word-break:break-all"><a href="${signingUrl}" style="color:#9A7545;font-size:12px">${signingUrl}</a></p>
    `,
    actionUrl: signingUrl,
    actionLabel: "Review & sign document",
    footerNote: `Sent via The Circle on behalf of ${escapeHtml(requesterName)}.`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
