import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createCapexTrackerRow } from '@/lib/capexTrackerHooks';
import { getRequestTypeLabel } from '@/lib/requestCode';
import { buildAndNotifySteps } from '@/lib/requestSteps';

/**
 * Rebuild a request title whose value part is the "Draft" placeholder (e.g.
 * "Hotel Booking: Draft") from the request's real metadata. Keeps the prefix
 * before the last ": " and substitutes the most relevant content field. Returns
 * the original title unchanged when it doesn't carry the placeholder.
 */
function deriveCleanTitle(title: string, metadata: any, description: string): string {
  if (!title || !/:\s*draft\s*$/i.test(title)) return title;
  const prefix = title.replace(/:\s*draft\s*$/i, '').trim();
  const firstLine = (v: any) =>
    typeof v === 'string' && v.trim() ? v.trim().split('\n')[0].trim() : '';
  const value =
    firstLine(metadata?.guestNames) ||
    firstLine(metadata?.projectName) ||
    (typeof metadata?.purposeOfTravel === 'string' ? metadata.purposeOfTravel.trim().slice(0, 50) : '') ||
    firstLine(description) ||
    '';
  return prefix && value ? `${prefix}: ${value}` : title;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);

    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const userId = user.id;
    const { id } = req.query;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    // Fetch the request to verify ownership and status
    const { data: request, error: fetchError } = await supabaseAdmin
      .from('requests')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Only the creator can publish their own request
    if (request.creator_id !== userId) {
      return res.status(403).json({ error: 'Only the request creator can publish this request' });
    }

    // Only draft requests can be published
    if (request.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft requests can be published' });
    }

    // A draft saved before its details were filled in gets a placeholder title
    // like "Hotel Booking: Draft". On publish, rebuild the value part from the
    // now-complete metadata so the live request never carries "Draft".
    const cleanTitle = deriveCleanTitle(request.title, request.metadata || {}, request.description || '');
    if (cleanTitle && cleanTitle !== request.title) {
      request.title = cleanTitle;
      await supabaseAdmin.from('requests').update({ title: cleanTitle }).eq('id', id);
    }

    // Build steps + notify the relevant approver(s). Single source of truth,
    // shared with POST /api/requests. Runs BEFORE the status flips so a failure
    // leaves the request as an editable draft.
    const stepResult = await buildAndNotifySteps({
      requestId: id,
      organizationId,
      creatorId: userId,
      title: request.title,
      metadata: request.metadata || {},
      requestType: request.metadata?.requestType || request.metadata?.type,
    });

    if (!stepResult.success) {
      return res.status(400).json({ error: stepResult.error });
    }

    // Update request status to pending
    const { data: updatedRequest, error: updateError } = await supabaseAdmin
      .from('requests')
      .update({
        status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    // CAPEX Tracker side-effect: when a CAPEX draft is published it enters the
    // approval trail, so it must appear on the tracker. Mirrors the same hook
    // run on direct (non-draft) submission in /api/requests. Fails silently —
    // never blocks the publish path.
    if (request.metadata?.type === 'capex' || request.metadata?.requestType === 'capex') {
      try {
        await createCapexTrackerRow(id, organizationId, userId);
      } catch (trackerErr) {
        console.error('Failed to create CAPEX tracker row on publish:', trackerErr);
      }
    }

    // Get the requester's name for notifications
    const { data: requesterData } = await supabaseAdmin
      .from('app_users')
      .select('display_name')
      .eq('id', userId)
      .single();

    const requesterName = requesterData?.display_name || 'A user';
    const requestType = request.metadata?.requestType || request.metadata?.type || 'general';
    const requestTypeLabel = getRequestTypeLabel(requestType);
    const requestTitle = request.title;

    // (First-approver notification is handled by buildAndNotifySteps above.)

    // Notify watchers if any
    const watcherIds: string[] = request.metadata?.watchers || [];
    if (watcherIds.length > 0) {
      const watcherNotifications = watcherIds.map((watcherId: string) => ({
        organization_id: organizationId,
        recipient_id: watcherId,
        sender_id: userId,
        type: 'info',
        title: 'Added as Watcher',
        message: `${requesterName} has added you as a watcher on their ${requestTypeLabel} request "${requestTitle}".`,
        metadata: {
          request_id: id,
          request_type: requestType,
          action_label: 'View Request',
          action_url: `/requests/comp/${id}`,
        },
        is_read: false,
      }));

      try {
        await supabaseAdmin
          .from('notifications')
          .insert(watcherNotifications);
      } catch (notifError) {
        console.error('Failed to create watcher notifications:', notifError);
      }
    }

    return res.status(200).json({
      success: true,
      request: updatedRequest,
      message: 'Request published successfully',
    });
  } catch (error: any) {
    console.error('Publish request error:', error);
    return res.status(500).json({ error: error.message || 'Failed to publish request' });
  }
}
