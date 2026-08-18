import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { getUserPreferences, saveUserPreferences } from '@/lib/userPreferences';
import { isGraphAppMailConfigured } from '@/lib/graphAppMail';

/**
 * GET  /api/user/preferences — the caller's notification/auto-archiving prefs,
 *      plus deployment integration status so the settings UI can explain
 *      features that are switched off at the environment level.
 * PUT  /api/user/preferences — save (partial) preference updates.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = (session.user as any).id;
  if (!userId) return res.status(400).json({ error: 'User ID not found' });

  if (req.method === 'GET') {
    const preferences = await getUserPreferences(userId);
    return res.status(200).json({
      preferences,
      integration: {
        // Outlook email via Graph, or Resend as fallback transport.
        emailConfigured: isGraphAppMailConfigured() || !!process.env.RESEND_API_KEY,
        // OneDrive per-user copies are enabled by the deployment.
        onedriveConfigured: !!(
          process.env.AZURE_CLIENT_ID &&
          process.env.AZURE_CLIENT_SECRET &&
          process.env.AZURE_TENANT &&
          process.env.GRAPH_ONEDRIVE_ENABLED === 'true'
        ),
        // Organisation-wide SharePoint archive target.
        sharepointConfigured: !!(
          process.env.GRAPH_SHAREPOINT_DRIVE_ID || process.env.GRAPH_SHAREPOINT_SITE_ID
        ),
      },
    });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const allowed = [
      'emailRequestUpdates',
      'emailApprovalTasks',
      'emailCompletionPdf',
      'approvalReminders',
      'reminderChannel',
      'reminderFrequency',
      'draftReminders',
      'weeklyDigest',
      'autoArchiveOneDrive',
      'oneDriveFolder',
      'landingPage',
      'tourCompleted',
      'onboardingDismissed',
    ] as const;
    const update: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) update[key] = body[key];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid preference fields provided' });
    }
    const result = await saveUserPreferences(userId, update);
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to save preferences' });
    }
    const preferences = await getUserPreferences(userId);
    return res.status(200).json({ success: true, preferences });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
