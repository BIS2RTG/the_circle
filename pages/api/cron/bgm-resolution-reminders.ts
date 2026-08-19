import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAuthorizedCron } from './reminders';
import { sendBoardEmail } from '@/lib/graphCalendar';
import { brandedEmailShell } from '@/lib/emailShell';
import { daysUntilDue } from '@/lib/bgmResolutions';

/**
 * GET/POST /api/cron/bgm-resolution-reminders — BGM-04 automated progress
 * notifications. For each open action item with a deadline:
 *   * due within 3 days (and not past) → remind the owner once (notified_due_soon)
 *   * overdue                          → alert the owner + the resolution creator
 *                                        once (notified_overdue)
 * Idempotent per-milestone via the notified_* flags; best-effort throughout.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const today = new Date();
  const horizon = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

  // Candidate tasks: not resolved, have a due date on/before the 3-day horizon.
  const { data: tasks, error } = await supabaseAdmin
    .from('resolution_tasks')
    .select('id, title, due_date, status, owner_user_id, notified_due_soon, notified_overdue, resolution:board_resolutions(id, title, created_by)')
    .neq('status', 'resolved')
    .not('due_date', 'is', null)
    .lte('due_date', horizon.toISOString().slice(0, 10));

  if (error) return res.status(500).json({ error: error.message });

  const base = (process.env.NEXTAUTH_URL || `https://${req.headers.host}`).replace(/\/+$/, '');
  let dueSoon = 0, overdue = 0;

  for (const t of tasks || []) {
    const days = daysUntilDue(t.due_date, today);
    if (days === null) continue;
    const resolution = (t as any).resolution;
    const url = `${base}/legal/board/resolutions/${resolution?.id || ''}`;

    if (days < 0) {
      // Overdue.
      if (t.notified_overdue) continue;
      const overdueDays = Math.abs(days);
      const recipients = new Set<string>();
      if (t.owner_user_id) recipients.add(t.owner_user_id);
      if (resolution?.created_by) recipients.add(resolution.created_by);
      for (const rid of recipients) {
        await supabaseAdmin.from('notifications').insert({
          recipient_id: rid, type: 'task', title: 'Board action overdue',
          message: `"${t.title}" (${resolution?.title || 'resolution'}) is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue.`,
          metadata: { action_label: 'View action', action_url: `/legal/board/resolutions/${resolution?.id || ''}` }, is_read: false,
        }).then(() => {}, () => {});
      }
      if (t.owner_user_id) await emailOwner(t.owner_user_id, t.title, resolution?.title, url, `is now ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`);
      await supabaseAdmin.from('resolution_tasks').update({ notified_overdue: true }).eq('id', t.id);
      overdue++;
    } else if (days >= 0 && days <= 3) {
      // Due soon.
      if (t.notified_due_soon) continue;
      if (t.owner_user_id) {
        await supabaseAdmin.from('notifications').insert({
          recipient_id: t.owner_user_id, type: 'task', title: 'Board action due soon',
          message: `"${t.title}" (${resolution?.title || 'resolution'}) is due ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}.`,
          metadata: { action_label: 'View action', action_url: `/legal/board/resolutions/${resolution?.id || ''}` }, is_read: false,
        }).then(() => {}, () => {});
        await emailOwner(t.owner_user_id, t.title, resolution?.title, url, days === 0 ? 'is due today' : `is due in ${days} day${days === 1 ? '' : 's'}`);
      }
      await supabaseAdmin.from('resolution_tasks').update({ notified_due_soon: true }).eq('id', t.id);
      dueSoon++;
    }
  }

  return res.status(200).json({ ok: true, dueSoon, overdue });
}

async function emailOwner(ownerUserId: string, taskTitle: string, resolutionTitle: string | undefined, url: string, phrase: string) {
  try {
    const { data: u } = await supabaseAdmin.from('app_users').select('email, display_name').eq('id', ownerUserId).maybeSingle();
    if (!u?.email) return;
    const html = brandedEmailShell({
      heading: 'Board action reminder',
      bodyHtml: `
        <p style="margin:0 0 12px">Dear ${escapeHtml(u.display_name || 'colleague')},</p>
        <p style="margin:0 0 12px">Your board action <strong>${escapeHtml(taskTitle)}</strong>${resolutionTitle ? ` (${escapeHtml(resolutionTitle)})` : ''} ${escapeHtml(phrase)}.</p>
        <p style="margin:0 0 12px">Please update its status in The Circle.</p>
      `,
      actionUrl: url,
      actionLabel: 'Update action',
    });
    await sendBoardEmail(ownerUserId, { to: u.email, subject: `Reminder: ${taskTitle}`, html });
  } catch { /* best-effort */ }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
