/**
 * Microsoft Graph calendar helper — distributes board/committee meeting
 * invitations via Microsoft Outlook (BGM-01).
 *
 * Primary path: create a real Outlook calendar event on the signed-in legal
 * user's calendar (`/me/events`) with the directors as attendees. Graph then
 * emails each attendee a genuine Outlook meeting invite (accept/decline, adds
 * to their calendar) — exactly the "distribute via Outlook" requirement.
 *
 * Fallback (no delegated Graph token, e.g. GRAPH_* not configured): generate a
 * standards-compliant .ics and email it to attendees through the existing
 * notification transport, so invitations still go out. Best-effort — the caller
 * decides how to surface partial failures; nothing here throws for delivery.
 */

import { getValidMsAccessToken } from './msTokenStore';
import { brandedEmailShell } from './emailShell';
import { sendAppGraphMail, isGraphAppMailConfigured } from './graphAppMail';
import { sendEmail as sendResendEmail } from './email';

export interface MeetingAttendeeInput {
  email: string;
  name?: string | null;
}

export interface OutlookEventInput {
  subject: string;
  /** ISO 8601 start/end. */
  start: string;
  end: string;
  timeZone: string; // IANA, e.g. 'Africa/Harare'
  location?: string | null;
  isOnline?: boolean;
  onlineLink?: string | null;
  bodyHtml?: string | null;
  attendees: MeetingAttendeeInput[];
}

export interface OutlookEventResult {
  eventId: string;
  webLink: string | null;
}

/**
 * Create an Outlook event as the signed-in user. Throws on Graph failure so the
 * caller can fall back. Attendees receive native Outlook invitations.
 */
export async function createOutlookMeeting(
  accessToken: string,
  input: OutlookEventInput
): Promise<OutlookEventResult> {
  const body = {
    subject: input.subject,
    body: { contentType: 'HTML', content: input.bodyHtml || '' },
    start: { dateTime: toGraphDateTime(input.start), timeZone: input.timeZone },
    end: { dateTime: toGraphDateTime(input.end), timeZone: input.timeZone },
    location: input.location ? { displayName: input.location } : undefined,
    isOnlineMeeting: !!input.isOnline,
    attendees: input.attendees
      .filter((a) => !!a.email)
      .map((a) => ({
        emailAddress: { address: a.email, name: a.name || undefined },
        type: 'required',
      })),
  };

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Graph createEvent failed (${resp.status}): ${text || resp.statusText}`);
  }

  const data = await resp.json();
  return { eventId: data.id, webLink: data.webLink ?? null };
}

/** Cancel a previously created Outlook event (best-effort; throws on failure). */
export async function cancelOutlookMeeting(accessToken: string, eventId: string, comment?: string): Promise<void> {
  const resp = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Comment: comment || 'This meeting has been cancelled.' }),
  });
  // /cancel only works for the organiser; if it 400s (e.g. single event), delete.
  if (!resp.ok) {
    await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }
}

/**
 * Send one board email via the most reliable available transport, in order:
 *   1. the user's DELEGATED Graph mailbox (`/me/sendMail`) — needs only the
 *      `Mail.Send` scope that sign-in already grants, and lands in their real
 *      Outlook Sent Items;
 *   2. the application service mailbox (`GRAPH_MAIL_SENDER`);
 *   3. Resend.
 * Returns true if any transport accepted the message. Never throws.
 */
export async function sendBoardEmail(
  userId: string | null | (string | null)[],
  opts: { to: string; subject: string; html: string; ics?: { name: string; content: Buffer } }
): Promise<boolean> {
  // 1. Delegated mailbox — try each candidate (e.g. the person acting AND the
  //    meeting creator), since only some users have a stored Graph token.
  //    Works with the Mail.Send scope sign-in already grants.
  const candidates = Array.isArray(userId) ? userId : [userId];
  const tried = new Set<string>();
  for (const uid of candidates) {
    if (!uid || tried.has(uid)) continue;
    tried.add(uid);
    try {
      const token = await getValidMsAccessToken(uid);
      if (token && (await sendDelegatedMail(token, opts))) return true;
    } catch (err) {
      console.error('[bgm] delegated mail failed for', uid, '- trying next:', err);
    }
  }
  // 2. Application service mailbox (with the .ics attachment if present).
  if (isGraphAppMailConfigured()) {
    try {
      const res = await sendAppGraphMail({
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        attachments: opts.ics ? [{ name: opts.ics.name, contentType: 'text/calendar; method=REQUEST', content: opts.ics.content }] : undefined,
      });
      if (res.success) return true;
    } catch (err) {
      console.error('[bgm] app mail failed, trying Resend:', err);
    }
  }
  // 3. Resend (the wrapper has no attachment support; the details are in the body).
  try {
    await sendResendEmail({ to: opts.to, subject: opts.subject, html: opts.html });
    return true;
  } catch (err) {
    console.error('[bgm] Resend failed:', err);
    return false;
  }
}

async function sendDelegatedMail(
  accessToken: string,
  opts: { to: string; subject: string; html: string; ics?: { name: string; content: Buffer } }
): Promise<boolean> {
  const message: Record<string, any> = {
    subject: opts.subject,
    body: { contentType: 'HTML', content: opts.html },
    toRecipients: [{ emailAddress: { address: opts.to } }],
  };
  if (opts.ics) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: opts.ics.name,
      contentType: 'text/calendar; method=REQUEST',
      contentBytes: opts.ics.content.toString('base64'),
    }];
  }
  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!resp.ok) {
    console.error('[bgm] delegated sendMail failed:', resp.status, await resp.text().catch(() => ''));
    return false;
  }
  return true;
}

/**
 * Distribute a meeting invitation. Tries a real Outlook calendar event first
 * (needs Calendars.ReadWrite — usually not granted, so it falls through), then
 * emails a branded invitation + .ics to each attendee via sendBoardEmail.
 */
export async function distributeMeetingInvitation(params: {
  /** One or more candidate senders (e.g. the acting user AND the meeting creator). */
  organiserUserId: string | (string | null)[];
  organiserName?: string | null;
  event: OutlookEventInput;
  uid: string; // stable id for the .ics (meeting id)
}): Promise<{ transport: 'outlook' | 'ics_email' | 'none'; eventId?: string; webLink?: string | null; error?: string }> {
  const { organiserUserId, event, uid } = params;
  const senderIds = Array.isArray(organiserUserId) ? organiserUserId : [organiserUserId];

  // 1. Best experience: a real Outlook event. Only works with Calendars.ReadWrite;
  //    a 403/absent scope just falls through to email.
  for (const sid of senderIds) {
    if (!sid) continue;
    try {
      const token = await getValidMsAccessToken(sid);
      if (token) {
        const res = await createOutlookMeeting(token, event);
        return { transport: 'outlook', eventId: res.eventId, webLink: res.webLink };
      }
    } catch (err) {
      console.error('[bgm] Outlook event unavailable, emailing an .ics instead:', err);
      break; // scope/permission issue — don't retry Outlook for other senders
    }
  }

  // 2. Email a branded invitation + .ics to each attendee.
  const recipients = event.attendees.filter((a) => !!a.email);
  if (recipients.length === 0) return { transport: 'none', error: 'no_recipients' };

  const ics = buildIcs({
    uid,
    subject: event.subject,
    start: event.start,
    end: event.end,
    location: event.location || event.onlineLink || '',
    description: stripHtml(event.bodyHtml || ''),
    organiserName: params.organiserName || 'The Circle',
  });
  const html = brandedEmailShell({
    heading: event.subject,
    bodyHtml: `
      <p style="margin:0 0 16px">You are invited to the following meeting.</p>
      <p style="margin:0 0 8px"><strong>When:</strong> ${escapeHtml(formatWhen(event.start, event.timeZone))}</p>
      ${event.location ? `<p style="margin:0 0 8px"><strong>Where:</strong> ${escapeHtml(event.location)}</p>` : ''}
      ${event.onlineLink ? `<p style="margin:0 0 8px"><strong>Join:</strong> ${escapeHtml(event.onlineLink)}</p>` : ''}
      <p style="margin:16px 0 0">A calendar invitation (.ics) is attached — open it to add this meeting to your calendar.</p>
    `,
  });
  const subject = `Invitation: ${event.subject}`;
  const icsAttachment = { name: 'invite.ics', content: Buffer.from(ics, 'utf8') };

  let anySent = false;
  for (const r of recipients) {
    if (await sendBoardEmail(senderIds, { to: r.email, subject, html, ics: icsAttachment })) anySent = true;
  }
  return anySent ? { transport: 'ics_email' } : { transport: 'none', error: 'no_mail_transport' };
}

/** Graph wants 'YYYY-MM-DDTHH:mm:ss' with no timezone suffix (tz sent separately). */
function toGraphDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function buildIcs(p: {
  uid: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  description: string;
  organiserName: string;
}): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//The Circle//BGM//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${p.uid}@thecircle`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(p.start)}`,
    `DTEND:${fmt(p.end)}`,
    `SUMMARY:${esc(p.subject)}`,
    p.location ? `LOCATION:${esc(p.location)}` : '',
    p.description ? `DESCRIPTION:${esc(p.description)}` : '',
    `ORGANIZER;CN=${esc(p.organiserName)}:mailto:noreply@thecircle`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
