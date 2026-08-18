import { Resend } from 'resend';
import { brandedEmailShell } from './emailShell';
import { graphMailSender } from './graphAppMail';

// Construct the client lazily — `new Resend(undefined)` throws, which would
// crash any API route that merely imports this module when RESEND_API_KEY is
// unset (e.g. local dev). Build it on first use only when a key is present.
let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail({ to, subject, html, text }: SendEmailOptions) {
  const resend = getResend();
  if (!resend) {
    console.warn('RESEND_API_KEY not configured. Email not sent.');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    // Single canonical sender for every notification, driven by the same env
    // (GRAPH_MAIL_SENDER, default thecircle@rtg.co.zw) that the service mailbox
    // uses — so the From is identical no matter which transport delivers.
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || `The Circle <${graphMailSender()}>`,
      to: [to],
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    });

    if (error) {
      console.error('Resend error:', error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err: any) {
    console.error('Email send error:', err);
    return { success: false, error: err.message };
  }
}

export function getPinResetEmailHtml(resetUrl: string, userName?: string) {
  return brandedEmailShell({
    heading: 'Reset your approval PIN',
    preheader: 'Set a new approval PIN for The Circle. This link expires in 1 hour.',
    bodyHtml: `
      <p style="margin:0 0 16px">Hi${userName ? ` ${escapeEmailText(userName)}` : ''},</p>
      <p style="margin:0 0 16px">You requested to reset your approval PIN for <strong>The Circle</strong>. Use the button below to set a new PIN.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f7f2ea;border:1px solid #eadfce;border-radius:8px;margin:20px 0">
        <tr><td style="padding:14px 16px;color:#8a6d3b;font-size:13px;line-height:1.5">
          <strong>This link expires in 1 hour.</strong> If you didn’t request this reset, you can safely ignore this email or contact IT support.
        </td></tr>
      </table>
      <p style="margin:16px 0 4px;color:#6b7280;font-size:13px">If the button doesn’t work, copy and paste this link into your browser:</p>
      <p style="margin:0;word-break:break-all"><a href="${resetUrl}" style="color:#9A7545;font-size:13px">${resetUrl}</a></p>
    `,
    actionUrl: resetUrl,
    actionLabel: 'Reset my PIN',
    footerNote: 'This is an automated message — please don’t reply. If you didn’t request a PIN reset, contact IT support.',
  });
}

/** Minimal HTML escaper for values interpolated into email markup. */
function escapeEmailText(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function getPinResetEmailText(resetUrl: string, userName?: string) {
  return `
Hi${userName ? ` ${userName}` : ''},

You requested to reset your approval PIN for The Circle.

Click the link below to set a new PIN:
${resetUrl}

This link will expire in 1 hour.

If you didn't request this reset, please ignore this email or contact IT support.

---
Rainbow Tourism Group • The Circle Approval System
This is an automated message. Please do not reply to this email.
  `.trim();
}
