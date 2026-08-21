/**
 * Shared Microsoft Graph / Outlook Calendar helper for Board & Governance meetings.
 */

import { sendAppGraphMail, isGraphAppMailConfigured } from './graphAppMail';

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

/**
 * Send an email related to board/committee governance (reminders, signing links).
 * Uses app-level Graph mail if configured, falling back to false if unavailable.
 */
export async function sendBoardEmail(
  _userIds: string | (string | null)[] | null | undefined,
  options: SendBoardEmailOptions
): Promise<boolean> {
  try {
    if (isGraphAppMailConfigured()) {
      const res = await sendAppGraphMail({
        to: options.to,
        subject: options.subject,
        html: options.html,
      });
      return res.success;
    }
    // Fallback: If app Graph mail is not fully configured, return false so callers log graceful fallback
    return false;
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

  if (isGraphAppMailConfigured()) {
    let sentCount = 0;
    for (const att of event.attendees) {
      if (!att.email) continue;
      const res = await sendAppGraphMail({
        to: att.email,
        subject: `Invitation: ${event.subject}`,
        html: `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>${event.subject}</h2>
            <p><strong>When:</strong> ${new Date(event.start).toLocaleString()} - ${new Date(event.end).toLocaleString()}</p>
            ${event.location ? `<p><strong>Where:</strong> ${event.location}</p>` : ''}
            ${event.onlineLink ? `<p><strong>Join Online:</strong> <a href="${event.onlineLink}">${event.onlineLink}</a></p>` : ''}
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
            ${event.bodyHtml || ''}
          </div>
        `,
      });
      if (res.success) sentCount++;
    }

    if (sentCount > 0) {
      return { transport: 'email' };
    }
  }

  return { transport: 'none', error: 'Microsoft Graph mail credentials not configured' };
}
