/**
 * Notifications for board attendance sign-off (BGM-02).
 *
 * When a board member signs for attendance, the meeting's initiator (the legal
 * team member who created it) is notified — in-app + email — and, once EVERY
 * invited member has signed, they get a "ready to finalize" nudge. Best-effort
 * throughout: a notification failure must never break the signing itself.
 */
import { supabaseAdmin } from './supabaseAdmin';
import { sendBoardEmail } from './graphCalendar';
import { brandedEmailShell } from './emailShell';

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Notify the meeting initiator that `signerName` signed, and — if that was the
 * last outstanding signature — that the register is ready to finalize.
 */
export async function notifyAttendanceSigned(meetingId: string, signerName: string): Promise<void> {
  try {
    const { data: meeting } = await supabaseAdmin
      .from('board_meetings')
      .select('id, title, created_by, organization_id, finalized_at')
      .eq('id', meetingId)
      .maybeSingle();
    if (!meeting || !meeting.created_by || meeting.finalized_at) return;

    const base = (process.env.NEXTAUTH_URL || '').replace(/\/+$/, '');
    const url = `${base}/legal/board/meetings/${meeting.id}`;

    // Resolve the initiator's email once (used for both notices).
    const { data: organiser } = await supabaseAdmin
      .from('app_users').select('email').eq('id', meeting.created_by).maybeSingle();

    // 1. Per-signature notice.
    await supabaseAdmin.from('notifications').insert({
      organization_id: meeting.organization_id,
      recipient_id: meeting.created_by,
      type: 'task',
      title: 'Attendance signed',
      message: `${signerName} has signed for attendance at "${meeting.title}".`,
      metadata: { action_label: 'Open register', action_url: `/legal/board/meetings/${meeting.id}` },
      is_read: false,
    }).then(() => {}, () => {});

    if (organiser?.email) {
      const html = brandedEmailShell({
        heading: `Attendance signed: ${meeting.title}`,
        bodyHtml: `<p style="margin:0 0 12px"><strong>${escapeHtml(signerName)}</strong> has signed for attendance at <strong>${escapeHtml(meeting.title)}</strong>.</p>`,
        actionUrl: url,
        actionLabel: 'Open register',
      });
      await sendBoardEmail(meeting.created_by, { to: organiser.email, subject: `Attendance signed: ${meeting.title}`, html });
    }

    // 2. Everyone signed → ready to finalize.
    const { data: rows } = await supabaseAdmin
      .from('meeting_attendance')
      .select('check_in_signature')
      .eq('meeting_id', meeting.id);
    const total = (rows || []).length;
    const signed = (rows || []).filter((r: any) => !!r.check_in_signature).length;
    if (total > 0 && signed === total) {
      await supabaseAdmin.from('notifications').insert({
        organization_id: meeting.organization_id,
        recipient_id: meeting.created_by,
        type: 'task',
        title: 'Register ready to finalize',
        message: `All ${total} member(s) have signed for "${meeting.title}". You can now finalize the register.`,
        metadata: { action_label: 'Finalize register', action_url: `/legal/board/meetings/${meeting.id}` },
        is_read: false,
      }).then(() => {}, () => {});

      if (organiser?.email) {
        const html = brandedEmailShell({
          heading: `Ready to finalize: ${meeting.title}`,
          bodyHtml: `<p style="margin:0 0 12px">All <strong>${total}</strong> invited member(s) have now signed for their attendance at <strong>${escapeHtml(meeting.title)}</strong>.</p>
                     <p style="margin:0 0 12px">The register is complete and ready to be finalized for the minute book.</p>`,
          actionUrl: url,
          actionLabel: 'Finalize register',
        });
        await sendBoardEmail(meeting.created_by, { to: organiser.email, subject: `Ready to finalize: ${meeting.title}`, html });
      }
    }
  } catch (err) {
    console.error('notifyAttendanceSigned failed (non-fatal):', err);
  }
}
