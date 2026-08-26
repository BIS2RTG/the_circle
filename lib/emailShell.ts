/**
 * Shared email chrome for every transactional email The Circle sends
 * (workflow notifications, PIN reset, e-sign invites). Rendering them all
 * through one shell keeps the look consistent with the app: RTG logo + "The
 * Circle" wordmark header, brown accent, neutral body, footer. No emojis — use
 * the accent bar / inline SVG for visual structure.
 */

export function appBaseUrl(): string {
  return (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Absolute URL of the logo used in email headers (overridable for deployments
 *  whose public asset host differs from NEXTAUTH_URL). */
export function emailLogoUrl(): string {
  return process.env.EMAIL_LOGO_URL || `${appBaseUrl()}/images/RTG_LOGO.png`;
}

export function brandedEmailShell(params: {
  heading: string;
  bodyHtml: string;
  actionUrl?: string | null;
  actionLabel?: string | null;
  /** Hidden inbox-preview line. */
  preheader?: string | null;
  /** Footer note under the standard org line. */
  footerNote?: string | null;
}): string {
  const button = params.actionUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0"><tr><td>
         <a href="${params.actionUrl}" style="display:inline-block;padding:13px 30px;background-color:#9A7545;color:#ffffff;text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;border-radius:8px">
           ${params.actionLabel || 'View in The Circle'}
         </a>
       </td></tr></table>`
    : '';
  const preheader = params.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f4f1ec">${params.preheader}</div>`
    : '';
  const footerNote =
    params.footerNote ||
    'This is an automated message — please don’t reply. You can change which emails you receive under My Settings.';

  return `
    <div style="margin:0;padding:0;background:#f4f1ec">
      ${preheader}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 12px">
        <tr><td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e2d8">
            <!-- Slim brand accent bar -->
            <tr><td style="height:6px;background:#9A7545;font-size:0;line-height:0">&nbsp;</td></tr>
            <!-- Brand header: RTG logo. alt="" so a client that blocks remote
                 images shows nothing ugly (the footer still names the org);
                 when images load the logo renders. -->
            <tr><td style="padding:22px 32px 0;font-family:'Segoe UI',Arial,sans-serif">
              <img src="${emailLogoUrl()}" alt="" height="40" style="display:block;height:40px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none" />
            </td></tr>
            <!-- Body -->
            <tr><td style="padding:32px;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937">
              <h1 style="margin:0 0 14px;font-size:19px;line-height:1.35;color:#111827;font-weight:700">${params.heading}</h1>
              <div style="font-size:14px;line-height:1.65;color:#374151">${params.bodyHtml}</div>
              ${button}
            </td></tr>
            <!-- Footer -->
            <tr><td style="padding:20px 32px;background:#faf8f4;border-top:1px solid #eee7db;font-family:'Segoe UI',Arial,sans-serif">
              <p style="margin:0;color:#8a8279;font-size:12px;font-weight:600;letter-spacing:0.2px">Rainbow Tourism Group</p>
              <p style="margin:6px 0 0;color:#b3aca2;font-size:11px;line-height:1.5">${footerNote}</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </div>`;
}
