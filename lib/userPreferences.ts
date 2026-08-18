/**
 * Per-user notification + auto-archiving preferences (user_preferences table).
 *
 * Read/written only through the service role. Every reader falls back to the
 * defaults below when the row (or even the table) is missing, so preference
 * checks can never break a workflow action.
 */

import { supabaseAdmin } from './supabaseAdmin';

export type ReminderChannel = 'email' | 'in_app' | 'both' | 'none';
export type ReminderFrequency = 'daily' | 'every_2_days' | 'weekly' | 'off';

export interface UserPreferences {
  /** Email me when my request is approved/rejected at a review step. */
  emailRequestUpdates: boolean;
  /** Email me when a request is waiting on my approval. */
  emailApprovalTasks: boolean;
  /** Email me the signed PDF when my request completes review. */
  emailCompletionPdf: boolean;
  /**
   * Email gate for pending-approval reminders (checked by notificationEmail
   * for kind='reminder'). Kept in sync with reminderChannel on save
   * (email/both ⇒ true) so existing email gating keeps working.
   */
  approvalReminders: boolean;
  /** How reminders reach me: email | in_app | both | none. */
  reminderChannel: ReminderChannel;
  /** How often to remind me about stale work: daily | every_2_days | weekly | off. */
  reminderFrequency: ReminderFrequency;
  /** Also remind me about my own unsubmitted drafts. */
  draftReminders: boolean;
  /** Weekly summary of my activity. */
  weeklyDigest: boolean;
  /** Auto-save my approved PDFs into my OneDrive. */
  autoArchiveOneDrive: boolean;
  /** Custom OneDrive folder name (null = deployment default). */
  oneDriveFolder: string | null;
  /** Default page to open after login (path, null = /dashboard). */
  landingPage: string | null;
  /**
   * Whether the user has completed/dismissed the post-onboarding feature tour.
   * Persisted server-side so the tour doesn't re-run on a new browser/device.
   */
  tourCompleted: boolean;
  /**
   * Whether the user dismissed the first-login onboarding wizard (the business
   * unit / department setup). Only offered on non-production (staging/legal)
   * deployments; persisted server-side so it never prompts again on any device.
   */
  onboardingDismissed: boolean;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  emailRequestUpdates: true,
  emailApprovalTasks: true,
  emailCompletionPdf: true,
  approvalReminders: true,
  reminderChannel: 'both',
  reminderFrequency: 'daily',
  draftReminders: true,
  weeklyDigest: false,
  autoArchiveOneDrive: true,
  oneDriveFolder: null,
  landingPage: null,
  tourCompleted: false,
  onboardingDismissed: false,
};

function rowToPrefs(row: any): UserPreferences {
  if (!row) return { ...DEFAULT_USER_PREFERENCES };
  return {
    emailRequestUpdates: row.email_request_updates ?? true,
    emailApprovalTasks: row.email_approval_tasks ?? true,
    emailCompletionPdf: row.email_completion_pdf ?? true,
    approvalReminders: row.approval_reminders ?? true,
    reminderChannel: (row.reminder_channel as ReminderChannel) || 'both',
    reminderFrequency: (row.reminder_frequency as ReminderFrequency) || 'daily',
    draftReminders: row.draft_reminders ?? true,
    weeklyDigest: row.weekly_digest ?? false,
    autoArchiveOneDrive: row.auto_archive_onedrive ?? true,
    oneDriveFolder: row.onedrive_folder || null,
    landingPage: row.landing_page || null,
    tourCompleted: row.tour_completed ?? false,
    onboardingDismissed: row.onboarding_dismissed ?? false,
  };
}

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.warn('userPreferences: read failed, using defaults:', error.message);
      return { ...DEFAULT_USER_PREFERENCES };
    }
    return rowToPrefs(data);
  } catch (e) {
    console.warn('userPreferences: read threw, using defaults:', e);
    return { ...DEFAULT_USER_PREFERENCES };
  }
}

/** Batch variant for cron jobs — returns defaults for users without a row. */
export async function getPreferencesForUsers(userIds: string[]): Promise<Map<string, UserPreferences>> {
  const map = new Map<string, UserPreferences>();
  for (const id of userIds) map.set(id, { ...DEFAULT_USER_PREFERENCES });
  if (userIds.length === 0) return map;
  try {
    const { data } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .in('user_id', userIds);
    for (const row of data || []) map.set(row.user_id, rowToPrefs(row));
  } catch (e) {
    console.warn('userPreferences: batch read failed, using defaults:', e);
  }
  return map;
}

export async function saveUserPreferences(
  userId: string,
  prefs: Partial<UserPreferences>
): Promise<{ success: boolean; error?: string }> {
  const row: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString() };
  if (prefs.emailRequestUpdates !== undefined) row.email_request_updates = !!prefs.emailRequestUpdates;
  if (prefs.emailApprovalTasks !== undefined) row.email_approval_tasks = !!prefs.emailApprovalTasks;
  if (prefs.emailCompletionPdf !== undefined) row.email_completion_pdf = !!prefs.emailCompletionPdf;
  if (prefs.approvalReminders !== undefined) row.approval_reminders = !!prefs.approvalReminders;
  if (prefs.reminderChannel !== undefined) {
    const allowed: ReminderChannel[] = ['email', 'in_app', 'both', 'none'];
    const channel = allowed.includes(prefs.reminderChannel as ReminderChannel)
      ? (prefs.reminderChannel as ReminderChannel)
      : 'both';
    row.reminder_channel = channel;
    // Keep the legacy email gate in sync so notificationEmail still honours it.
    row.approval_reminders = channel === 'email' || channel === 'both';
  }
  if (prefs.reminderFrequency !== undefined) {
    const allowed: ReminderFrequency[] = ['daily', 'every_2_days', 'weekly', 'off'];
    row.reminder_frequency = allowed.includes(prefs.reminderFrequency as ReminderFrequency)
      ? (prefs.reminderFrequency as ReminderFrequency)
      : 'daily';
  }
  if (prefs.draftReminders !== undefined) row.draft_reminders = !!prefs.draftReminders;
  if (prefs.weeklyDigest !== undefined) row.weekly_digest = !!prefs.weeklyDigest;
  if (prefs.autoArchiveOneDrive !== undefined) row.auto_archive_onedrive = !!prefs.autoArchiveOneDrive;
  if (prefs.oneDriveFolder !== undefined) {
    const folder = (prefs.oneDriveFolder || '').trim();
    row.onedrive_folder = folder ? folder.slice(0, 120) : null;
  }
  if (prefs.landingPage !== undefined) {
    const lp = (prefs.landingPage || '').trim();
    row.landing_page = lp ? lp.slice(0, 120) : null;
  }
  if (prefs.tourCompleted !== undefined) row.tour_completed = !!prefs.tourCompleted;
  if (prefs.onboardingDismissed !== undefined) row.onboarding_dismissed = !!prefs.onboardingDismissed;

  const { error } = await supabaseAdmin
    .from('user_preferences')
    .upsert(row, { onConflict: 'user_id' });
  if (error) {
    console.error('userPreferences: save failed:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}
