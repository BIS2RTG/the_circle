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
 * Distribute a meeting invitation. Tries Outlook (as `organiserUserId`), then
 * falls back to emailing an .ics. Returns which transport succeeded.
 */
export async function distributeMeetingInvitation(params: {
  organiserUserId: string;
  organiserName?: string | null;
  event: OutlookEventInput;
  uid: string; // stable id for the .ics (meeting id)
}): Promise<{ transport: 'outlook' | 'ics_email' | 'none'; eventId?: string; webLink?: string | null; error?: string }> {
  const { organiserUserId, event, uid } = params;

  // 1. Try Outlook via the organiser's delegated token.
  try {
    const token = await getValidMsAccessToken(organiserUserId);
    if (token) {
      const res = await createOutlookMeeting(token, event);
      return { transport: 'outlook', eventId: res.eventId, webLink: res.webLink };
    }
  } catch (err) {
    console.error('[bgm] Outlook invite failed, falling back to .ics email:', err);
  }

  // 2. Fallback: email an .ics to each attendee (best-effort, never throws).
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

  const icsAttachment = {
    name: 'invite.ics',
    contentType: 'text/calendar; method=REQUEST',
    content: Buffer.from(ics, 'utf8'),
  };
  const subject = `Invitation: ${event.subject}`;

  // Send per-recipient via the APP transport (service mailbox → Resend) so
  // invitations still go out even when the organiser has no delegated Graph
  // token (the common case on staging / preview). Never throws.
  let anySent = false;
  let lastError: string | undefined;
  const graphReady = isGraphAppMailConfigured();
  for (const r of recipients) {
    if (graphReady) {
      try {
        const res = await sendAppGraphMail({ to: r.email, subject, html, attachments: [icsAttachment] });
        if (res.success) { anySent = true; continue; }
        lastError = res.error;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    // Resend fallback (no attachment support in the wrapper; the join link and
    // details are in the branded body, so the invite is still actionable).
    try {
      await sendResendEmail({ to: r.email, subject, html });
      anySent = true;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  return anySent
    ? { transport: 'ics_email' }
    : { transport: 'none', error: lastError || 'no_mail_transport' };
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
