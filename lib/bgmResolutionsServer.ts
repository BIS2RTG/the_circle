/**
 * Server-only helpers for BGM-04 — resolution action notifications.
 * In-app notifications use type 'task' so they surface on the notification badge.
 * Emails go through sendBoardEmail (delegated Graph → service mailbox → Resend),
 * the same transport the rest of the BGM module uses. All notification writes
 * are best-effort and never fail the underlying action.
 */
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { brandedEmailShell } from '@/lib/emailShell';
import { sendBoardEmail } from '@/lib/graphCalendar';
import { TASK_STATUS_LABELS, effectiveStatus } from '@/lib/bgmResolutions';

const actionPath = (resolutionId: string) => `/legal/board/resolutions/${resolutionId}`;

async function notify(recipientId: string, title: string, message: string, resolutionId: string) {
  await supabaseAdmin.from('notifications').insert({
    recipient_id: recipientId,
    type: 'task',
    title,
    message,
    metadata: { action_label: 'View action', action_url: actionPath(resolutionId) },
    is_read: false,
  }).then(() => {}, () => {});
}

/** Notify an owner that they've been assigned a resolution action item. */
export async function notifyOwnerAssigned(params: {
  ownerUserId: string;
  taskTitle: string;
  resolutionTitle: string;
  resolutionId: string;
  dueDate: string | null;
  assignedByUserId: string | null;
  assignedByName: string | null;
}) {
  const { ownerUserId, taskTitle, resolutionTitle, resolutionId, dueDate, assignedByUserId, assignedByName } = params;
  const dueSentence = dueDate ? ` It is due by ${new Date(dueDate).toLocaleDateString('en-GB', { dateStyle: 'long' } as any)}.` : '';
  await notify(
    ownerUserId,
    'New board action assigned to you',
    `"${taskTitle}" (${resolutionTitle}) has been assigned to you${assignedByName ? ` by ${assignedByName}` : ''}.${dueSentence}`,
    resolutionId,
  );

  try {
    const { data: u } = await supabaseAdmin.from('app_users').select('email, display_name').eq('id', ownerUserId).maybeSingle();
    if (u?.email) {
      const base = appBase();
      const html = brandedEmailShell({
        heading: 'A board action has been assigned to you',
        bodyHtml: `
          <p style="margin:0 0 12px">Dear ${escapeHtml(u.display_name || 'colleague')},</p>
          <p style="margin:0 0 12px">You have been made responsible for the following board action:</p>
          <p style="margin:0 0 6px"><strong>${escapeHtml(taskTitle)}</strong></p>
          <p style="margin:0 0 12px">Arising from resolution: ${escapeHtml(resolutionTitle)}.${dueSentence ? escapeHtml(dueSentence) : ''}</p>
        `,
        actionUrl: `${base}${actionPath(resolutionId)}`,
        actionLabel: 'View action item',
        preheader: `You are responsible for: ${taskTitle}`,
      });
      const senders = [assignedByUserId, ownerUserId].filter(Boolean) as string[];
      await sendBoardEmail(senders, { to: u.email, subject: `Board action assigned: ${taskTitle}`, html });
    }
  } catch { /* best-effort */ }
}

/** Notify the resolution's creator when an owner updates a task's status. */
export async function notifyStatusChange(params: {
  recipientUserId: string | null;
  actorName: string | null;
  taskTitle: string;
  resolutionTitle: string;
  resolutionId: string;
  newStatus: string;
  dueDate: string | null;
  note?: string | null;
}) {
  const { recipientUserId, actorName, taskTitle, resolutionTitle, resolutionId, newStatus, dueDate, note } = params;
  if (!recipientUserId) return;
  const label = TASK_STATUS_LABELS[effectiveStatus({ status: newStatus, due_date: dueDate })] || newStatus;
  await notify(
    recipientUserId,
    'Board action updated',
    `${actorName || 'The owner'} moved "${taskTitle}" (${resolutionTitle}) to ${label}.${note ? ` Note: ${note}` : ''}`,
    resolutionId,
  );
}

function appBase(): string {
  return (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
