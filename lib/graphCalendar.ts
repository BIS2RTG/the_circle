/**
 * Shared Microsoft Graph / Outlook Calendar helper for Board & Governance meetings.
 */

import { sendAppGraphMail, isGraphAppMailConfigured, graphMailSender } from './graphAppMail';
import { sendGraphMail } from './graphMail';
import { getValidMsAccessToken, getAnyValidDelegatedSenderId } from './msTokenStore';
import { sendEmail as sendResendEmail } from './email';
import { supabaseAdmin } from './supabaseAdmin';
import { brandedEmailShell, appBaseUrl } from './emailShell';

export interface CalendarAttendee {
  email: string;
  name?: string;
}

export interface CalendarEventDetails {
  subject: string;
  start: string;
  end: string;
  timeZone?: string;
  location?: string | null;
  isOnline?: boolean;
  onlineLink?: string | null;
  bodyHtml?: string;
  attendees: CalendarAttendee[];
  /** Extra context surfaced in the branded invitation email. */
  meetingId?: string;
  organiserName?: string;
  committeeLabel?: string | null;
  platformLabel?: string | null;
  agenda?: string | null;
}

export interface DistributeMeetingInvitationOptions {
  organiserUserId?: string | (string | null)[] | null;
  organiserName?: string;
  uid: string;
  event: CalendarEventDetails;
}

export interface DistributeOutcome {
  transport: 'graph' | 'email' | 'none';
  eventId?: string;
  webLink?: string;
  error?: string;
}

export interface SendBoardEmailOptions {
  to: string;
  subject: string;
  html: string;
}

/** Normalise a userId / list-of-userIds argument to a de-duplicated string[]. */
function normaliseUserIds(userIds: string | (string | null)[] | null | undefined): string[] {
  const arr = Array.isArray(userIds) ? userIds : [userIds];
  return Array.from(new Set(arr.filter((x): x is string => typeof x === 'string' && x.length > 0)));
}

/**
 * Deliver one governance email through the same transport chain the workflow
 * notifications use, most-preferred first:
 *   1. Service mailbox (application Graph mail — "from The Circle").
 *   2. Resend (domain sender), when configured.
 *   3. A delegated Graph token belonging to one of the supplied users (the
 *      person sending / the meeting organiser), stamped as the service mailbox.
 *   4. Last-resort org relay: any connected mailbox in the same organisation.
 *
 * Previously this only tried the service mailbox, so on environments without
 * application Mail.Send admin consent every board email failed (surfacing to the
 * user as a 502). The delegated fallbacks mean it now delivers wherever the
 * e-sign / approval emails already do. Never throws — returns false on failure.
 */
async function deliverGovernanceEmail(
  userIds: string | (string | null)[] | null | undefined,
  options: SendBoardEmailOptions
): Promise<boolean> {
  const ids = normaliseUserIds(userIds);
  const serviceSender = { email: graphMailSender(), name: 'The Circle' };

  // Send via an individual's delegated token but present the shared service
  // mailbox as the From; retry without the override if Send-As is denied.
  const sendDelegatedAsService = async (token: string): Promise<void> => {
    try {
      await sendGraphMail({ accessToken: token, to: { email: options.to }, subject: options.subject, html: options.html, saveToSentItems: false, from: serviceSender });
    } catch {
      await sendGraphMail({ accessToken: token, to: { email: options.to }, subject: options.subject, html: options.html, saveToSentItems: false });
    }
  };

  const attempts: Array<() => Promise<boolean>> = [];

  if (isGraphAppMailConfigured()) {
    attempts.push(async () => (await sendAppGraphMail({ to: options.to, subject: options.subject, html: options.html })).success);
  }
  if (process.env.RESEND_API_KEY) {
    attempts.push(async () => !!(await sendResendEmail({ to: options.to, subject: options.subject, html: options.html })).success);
  }
  for (const uid of ids) {
    attempts.push(async () => {
      const token = await getValidMsAccessToken(uid);
      if (!token) return false;
      await sendDelegatedAsService(token);
      return true;
    });
  }
  // Org relay — borrow any connected mailbox in the sender's organisation.
  attempts.push(async () => {
    let organizationId: string | null = null;
    if (ids.length > 0) {
      const { data } = await supabaseAdmin.from('app_users').select('organization_id').eq('id', ids[0]).maybeSingle();
      organizationId = data?.organization_id || null;
    }
    const senderId = await getAnyValidDelegatedSenderId(organizationId, ids);
    if (!senderId) return false;
    const token = await getValidMsAccessToken(senderId);
    if (!token) return false;
    await sendDelegatedAsService(token);
    return true;
  });

  for (const run of attempts) {
    try {
      if (await run()) return true;
    } catch (err) {
      console.warn('deliverGovernanceEmail: transport failed:', (err as Error)?.message || err);
    }
  }
  return false;
}

/**
 * Send an email related to board/committee governance (reminders, signing links).
 * Uses the service mailbox when configured, falling back to delegated Graph
 * tokens (of the supplied users) and an org relay so it still delivers where
 * application Mail.Send consent isn't in place. Returns false only if no
 * transport at all could send.
 */
export async function sendBoardEmail(
  userIds: string | (string | null)[] | null | undefined,
  options: SendBoardEmailOptions
): Promise<boolean> {
  try {
    return await deliverGovernanceEmail(userIds, options);
  } catch (err) {
    console.error('sendBoardEmail failed:', err);
    return false;
  }
}

/**
 * Distribute board meeting invitations to attendees.
 */
export async function distributeMeetingInvitation(
  options: DistributeMeetingInvitationOptions
): Promise<DistributeOutcome> {
  const { event } = options;

  if (!event.attendees || event.attendees.length === 0) {
    return { transport: 'none', error: 'No attendees provided' };
  }

  // Use the same transport chain as sendBoardEmail (service mailbox → Resend →
  // the organiser's delegated token → org relay) so invitations still deliver
  // when application Mail.Send consent isn't in place. The email is branded and
  // built PER-RECIPIENT so the "add to calendar" action matches their provider.
  let sentCount = 0;
  for (const att of event.attendees) {
    if (!att.email) continue;
    const ok = await deliverGovernanceEmail(options.organiserUserId, {
      to: att.email,
      subject: `Invitation: ${event.subject}`,
      html: buildInvitationEmailHtml(event, att),
    });
    if (ok) sentCount++;
  }

  if (sentCount > 0) return { transport: 'email' };
  return { transport: 'none', error: 'No email transport available (connect Microsoft or configure the service mailbox / Resend).' };
}

function escapeHtmlCal(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Microsoft mailboxes (RTG staff) get a native Outlook "add to calendar" link;
 *  everyone else (gmail/yahoo/icloud/…) gets Google + a universal .ics file. */
function isMicrosoftMailbox(email: string): boolean {
  const domain = (email.split('@')[1] || '').toLowerCase();
  return domain.endsWith('rtg.co.zw') || domain.endsWith('onmicrosoft.com') ||
    domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com';
}

/** yyyymmddThhmmssZ (UTC) for Google Calendar template links. */
function toCalStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Format "When" as a full date with a start–end time range in the meeting tz. */
function formatWhen(event: CalendarEventDetails): string {
  const tz = event.timeZone || 'Africa/Harare';
  const start = new Date(event.start);
  const end = new Date(event.end);
  try {
    const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: tz }).format(start);
    const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d);
    return `${date}, ${time(start)} – ${time(end)}`;
  } catch {
    return `${start.toUTCString()} – ${end.toUTCString()}`;
  }
}

/** Build the branded, per-recipient invitation email (with add-to-calendar). */
function buildInvitationEmailHtml(event: CalendarEventDetails, attendee: CalendarAttendee): string {
  const base = appBaseUrl();
  const when = formatWhen(event);

  // Plain-text description for the calendar-link payloads.
  const descParts: string[] = [];
  if (event.committeeLabel) descParts.push(`Committee: ${event.committeeLabel}`);
  if (event.agenda) descParts.push(`Agenda: ${event.agenda}`);
  if (event.onlineLink) descParts.push(`Join: ${event.onlineLink}`);
  if (event.organiserName) descParts.push(`Organiser: ${event.organiserName}`);
  const description = descParts.join('\n');
  const locationText = event.isOnline || event.onlineLink
    ? (event.onlineLink || event.platformLabel || 'Online')
    : (event.location || '');

  const s = toCalStamp(event.start);
  const e = toCalStamp(event.end);
  const enc = encodeURIComponent;
  const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(event.subject)}&dates=${s}/${e}&details=${enc(description)}&location=${enc(locationText)}`;
  const outlookUrl = `https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${enc(event.subject)}&startdt=${enc(new Date(event.start).toISOString())}&enddt=${enc(new Date(event.end).toISOString())}&body=${enc(description)}&location=${enc(locationText)}`;
  const icsUrl = event.meetingId ? `${base}/api/legal/bgm/meetings/${event.meetingId}/calendar.ics` : '';

  // Detail rows.
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#8a8279;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;width:120px;vertical-align:top">${label}</td>
         <td style="padding:6px 0;color:#374151;font-size:14px;line-height:1.5">${value}</td></tr>`;
  const rows: string[] = [];
  rows.push(row('When', escapeHtmlCal(when)));
  if (event.isOnline || event.onlineLink) {
    const link = event.onlineLink ? `<a href="${escapeHtmlCal(event.onlineLink)}" style="color:#9A7545">${escapeHtmlCal(event.platformLabel || 'Join online')}</a>` : escapeHtmlCal(event.platformLabel || 'Online');
    rows.push(row('Where', link));
  } else if (event.location) {
    rows.push(row('Where', escapeHtmlCal(event.location)));
  }
  if (event.committeeLabel) rows.push(row('Committee', escapeHtmlCal(event.committeeLabel)));
  if (event.organiserName) rows.push(row('Organiser', escapeHtmlCal(event.organiserName)));
  if (event.agenda) rows.push(row('Agenda', escapeHtmlCal(event.agenda).replace(/\n/g, '<br>')));

  // Add-to-calendar buttons — provider matched to the recipient's mailbox.
  const primaryUrl = isMicrosoftMailbox(attendee.email) ? outlookUrl : googleUrl;
  const primaryLabel = isMicrosoftMailbox(attendee.email) ? 'Add to Outlook Calendar' : 'Add to Google Calendar';
  const altLinks: string[] = [];
  if (isMicrosoftMailbox(attendee.email)) {
    altLinks.push(`<a href="${googleUrl}" style="color:#9A7545;text-decoration:underline">Google Calendar</a>`);
  } else {
    altLinks.push(`<a href="${outlookUrl}" style="color:#9A7545;text-decoration:underline">Outlook</a>`);
  }
  if (icsUrl) altLinks.push(`<a href="${icsUrl}" style="color:#9A7545;text-decoration:underline">Apple / other (.ics)</a>`);

  const calendarBlock = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px"><tr><td>
      <a href="${primaryUrl}" style="display:inline-block;padding:13px 30px;background-color:#9A7545;color:#ffffff;text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;border-radius:8px">${primaryLabel}</a>
    </td></tr></table>
    <p style="margin:6px 0 0;color:#8a8279;font-size:12px">Prefer a different calendar? ${altLinks.join(' &nbsp;·&nbsp; ')}</p>`;

  const greeting = attendee.name ? `Dear ${escapeHtmlCal(attendee.name)},` : 'Good day,';
  const bodyHtml = `
    <p style="margin:0 0 14px">${greeting}</p>
    <p style="margin:0 0 16px">You are invited to the following meeting. Please add it to your calendar using the button below.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf8f4;border:1px solid #eee7db;border-radius:10px;padding:8px 16px;margin:0 0 8px">
      ${rows.join('')}
    </table>
    ${calendarBlock}`;

  return brandedEmailShell({
    heading: event.subject,
    preheader: `Meeting invitation — ${when}`,
    bodyHtml,
    footerNote: 'You are receiving this because you were invited to a Rainbow Tourism Group board/committee meeting.',
  });
}
