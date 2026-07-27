import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { validateBody, z } from '@/lib/validate';
import { ApprovalEngine } from '@/lib/approvalEngine';
import { assertValidOnBehalf } from '@/lib/onBehalf';
import { assistantCanActOn } from '@/lib/assistantAssignments';
import { isPermanentWatcherOf } from '@/lib/permanentWatchers';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from '@/lib/rbac';
import { audit } from '@/lib/auditLog';
import { fetchHrimsDepartmentById, fetchHrimsBusinessUnitById } from '@/lib/hrimsClient';

const UpdateRequestSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
  priority: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  metadata: z.record(z.any()).optional(),
  // `status` is intentionally accepted-but-ignored: status transitions go
  // through the dedicated submit/publish/withdraw endpoints.
  status: z.string().optional(),
}).strip();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerSession(req, res, authOptions);
    
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const { id } = req.query;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    if (req.method === 'GET') {
      const userId = user.id;
      
      const { data: request, error } = await supabaseAdmin
        .from('requests')
        .select(`
          id,
          title,
          description,
          status,
          metadata,
          created_at,
          updated_at,
          creator_id,
          organization_id,
          creator:app_users!requests_creator_id_fkey (
            id,
            display_name,
            email,
            profile_picture_url,
            department_id,
            business_unit_id,
            job_title
          ),
          request_steps (
            id,
            step_index,
            step_type,
            approver_role,
            approver_user_id,
            status,
            due_at,
            created_at,
            activated_at,
            first_viewed_at,
            last_viewed_at,
            is_redirected,
            original_approver_id,
            redirect_reason,
            delegation_id,
            approver:app_users!request_steps_approver_user_id_fkey (
              id,
              display_name,
              email,
              profile_picture_url,
              job_title
            ),
            approvals (
              id,
              decision,
              comment,
              signed_at,
              signature_url,
              signature_reference,
              signature_type,
              authentication_method,
              approver:app_users!approvals_approver_id_fkey (
                id,
                display_name,
                email,
                profile_picture_url
              )
            )
          ),
          documents (
            id,
            filename,
            storage_path,
            file_size,
            mime_type,
            created_at
          )
        `)
        .eq('id', id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Request not found' });
        }
        throw error;
      }

      // Elevated viewers — super admins and anyone granted requests.view_all
      // (e.g. auditors) — can open ANY request. Resolved lazily and memoised so
      // we only pay the RBAC lookup when a cheaper involvement check hasn't
      // already cleared the user.
      let rbacProfile: Awaited<ReturnType<typeof getUserRBACProfile>> | null = null;
      const isElevatedViewer = async (): Promise<boolean> => {
        if (!rbacProfile) rbacProfile = await getUserRBACProfile(userId);
        return rbacProfile.is_super_admin || hasPermission(rbacProfile, PERMISSIONS.REQUESTS_VIEW_ALL);
      };

      // Org scoping: the query is intentionally NOT filtered by organization so
      // that elevated viewers can reach a request in any organization. Normal
      // users stay strictly org-scoped — a request outside their org is treated
      // as non-existent (404, so we never reveal it lives in another org).
      const sameOrg = request.organization_id === organizationId;
      if (!sameOrg && !(await isElevatedViewer())) {
        return res.status(404).json({ error: 'Request not found' });
      }

      // SEQUENTIAL APPROVAL VISIBILITY CHECK
      // User can view the request if they are:
      // 1. The creator of the request
      // 2. A watcher on the request
      // 3. An approver whose step is 'pending' (their turn) or 'approved'/'rejected' (already acted)
      // Approvers with 'waiting' status should NOT see the request until it's their turn
      const isCreator = request.creator_id === userId;

      const watcherIds = request.metadata?.watchers || [];
      const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) =>
        typeof w === 'string' ? w === userId : w?.id === userId
      );

      // Check if user has an actionable or completed step (not waiting)
      const userStep = request.request_steps?.find(
        (step: any) => step.approver_user_id === userId
      );
      const canApproverView = userStep && userStep.status !== 'waiting';

      // Permanent watcher: read-only visibility of everything the creator or any
      // approver on this request has (they named this viewer as their watcher).
      const isPermanentWatcher = await isPermanentWatcherOf(userId, organizationId, request as any);

      if (!isCreator && !isWatcher && !canApproverView && !isPermanentWatcher) {
        if (!(await isElevatedViewer())) {
          // Not elevated, not involved, or a future approver whose turn hasn't come.
          if (userStep && userStep.status === 'waiting') {
            return res.status(403).json({
              error: 'This request is not yet ready for your review. You will be notified when it is your turn to approve.',
              code: 'APPROVAL_NOT_YOUR_TURN'
            });
          }
          return res.status(403).json({ error: 'You do not have permission to view this request' });
        }
      }

      // Sort request_steps by step_index
      if (request.request_steps) {
        request.request_steps.sort((a: any, b: any) => a.step_index - b.step_index);
      }

      // Calculate current step (first pending step)
      const currentStepIndex = request.request_steps?.findIndex((step: any) => step.status === 'pending') ?? -1;
      const currentStep = currentStepIndex >= 0 ? request.request_steps[currentStepIndex] : null;

      // Compute actual status based on step statuses (to handle incorrectly marked requests)
      const computeActualStatus = (dbStatus: string, steps: any[]) => {
        // Terminal / non-active statuses win over any leftover step states
        // (cancelling/withdrawing does not clear the steps).
        if (['cancelled', 'withdrawn', 'draft', 'expired'].includes(dbStatus)) return dbStatus;
        if (!steps || steps.length === 0) return dbStatus;

        // If any step is rejected, the request is rejected
        if (steps.some((s: any) => s.status === 'rejected')) return 'rejected';
        
        // If all steps are approved, the request is approved
        if (steps.every((s: any) => s.status === 'approved')) return 'approved';
        
        // If there are pending or waiting steps, the request is still in progress
        if (steps.some((s: any) => s.status === 'pending' || s.status === 'waiting')) return 'pending';
        
        return dbStatus;
      };

      const actualStatus = computeActualStatus(request.status, request.request_steps);

      // Resolve the creator's department / business unit NAMES. The IDs on
      // app_users reference the HRIMS database (a separate Supabase project),
      // so they can't be joined in the query above — without this, previews
      // fall back to '—' for department and business unit.
      const creator: any = request.creator;
      if (creator && (creator.department_id || creator.business_unit_id)) {
        try {
          const [dept, bu] = await Promise.all([
            creator.department_id ? fetchHrimsDepartmentById(creator.department_id) : Promise.resolve(null),
            creator.business_unit_id ? fetchHrimsBusinessUnitById(creator.business_unit_id) : Promise.resolve(null),
          ]);
          if (dept) creator.department = { id: dept.id, name: dept.name };
          if (bu) creator.business_unit = { id: bu.id, name: bu.name };
        } catch {
          // HRIMS unavailable — previews keep their metadata-based fallbacks.
        }
      }

      return res.status(200).json({
        request: {
          ...request,
          status: actualStatus,
          current_step: currentStepIndex >= 0 ? currentStepIndex + 1 : request.request_steps?.length || 0,
          total_steps: request.request_steps?.length || 0,
          current_approver: currentStep?.approver || null
        }
      });
    }

    if (req.method === 'PUT') {
      // Resource-level authorization: only the creator may edit a request
      // through this generic endpoint, and only while it is still a draft.
      // Approvers use the dedicated approver-edit route; status transitions go
      // through submit/approve/withdraw — never an arbitrary client-set status.
      const { data: existing, error: ownErr } = await supabaseAdmin
        .from('requests')
        .select('id, creator_id, status, metadata')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .single();

      if (ownErr) {
        if (ownErr.code === 'PGRST116') {
          return res.status(404).json({ error: 'Request not found' });
        }
        throw ownErr;
      }

      // The creator may edit; so may an assistant granted `can_edit` for the
      // creator or the on-behalf principal.
      const isEditAssistant =
        existing.creator_id !== user.id &&
        (await assistantCanActOn(user.id, organizationId, existing as any, 'can_edit'));

      if (existing.creator_id !== user.id && !isEditAssistant) {
        return res.status(403).json({ error: 'You can only edit your own requests' });
      }

      if (existing.status === 'approved') {
        return res.status(400).json({ error: 'Cannot edit a request that is already approved' });
      }

      const parsed = validateBody(req, res, UpdateRequestSchema);
      if (!parsed) return;
      const { title, description, priority, category } = parsed;
      let metadata = parsed.metadata;

      // Never trust a client-supplied beneficiary. When the creator edits, re-verify
      // it against their own assignments. When an assistant edits, they may not
      // reassign the beneficiary — preserve the stored value by dropping the key.
      if (metadata && 'onBehalfOf' in metadata) {
        if (isEditAssistant) {
          const { onBehalfOf: _ignored, ...rest } = metadata as any;
          metadata = rest;
        } else {
          const onBehalfResult = await assertValidOnBehalf(organizationId, user.id, (metadata as any).onBehalfOf);
          if (!onBehalfResult.ok) {
            return res.status(403).json({ error: onBehalfResult.error });
          }
          metadata = { ...metadata, onBehalfOf: onBehalfResult.normalized ?? null };
        }
      }

      // Editing a REJECTED request is treated as an "edit & resubmit": the
      // (possibly fully re-edited) form metadata is merged over the existing
      // metadata — preserving server-managed keys like referenceCode,
      // resubmissionCount and resubmissionHistory that the form doesn't carry —
      // then the workflow is reset and re-routed by the approval engine. This
      // is the path used by the form pages (?edit=<id>) for full structured
      // re-editing; the lightweight inline editor uses /resubmit instead.
      if (existing.status === 'rejected') {
        const { data: current } = await supabaseAdmin
          .from('requests')
          .select('metadata, title')
          .eq('id', id)
          .single();

        const previousReference = (current?.metadata as any)?.referenceCode || null;
        const mergedMetadata = { ...(current?.metadata || {}), ...(metadata || {}) };

        const resubmitUpdates: any = {
          metadata: mergedMetadata,
          updated_at: new Date().toISOString(),
        };
        if (title !== undefined) resubmitUpdates.title = title;
        if (description !== undefined) resubmitUpdates.description = description;
        if (priority !== undefined) resubmitUpdates.priority = priority;
        if (category !== undefined) resubmitUpdates.category = category;

        const { error: mergeErr } = await supabaseAdmin
          .from('requests')
          .update(resubmitUpdates)
          .eq('id', id)
          .eq('organization_id', organizationId);
        if (mergeErr) {
          console.error('Failed to persist resubmission edits:', mergeErr);
          return res.status(500).json({ error: 'Failed to save your changes' });
        }

        const result = await ApprovalEngine.resubmitRequest(id, user.id);

        await audit(req, session.user, {
          category: 'workflow',
          action: 'request.resubmitted',
          severity: 'notice',
          outcome: result.success ? 'success' : 'failure',
          targetType: 'request',
          targetId: id,
          requestId: id,
          targetLabel: result.newReference || title || current?.title || null,
          details: result.success
            ? {
                newReference: result.newReference || null,
                previousReference,
                version: result.version || null,
                via: 'form',
              }
            : { error: result.error },
        });

        if (!result.success) {
          return res.status(400).json({ error: result.error });
        }

        return res.status(200).json({
          request: { id, ...resubmitUpdates },
          resubmitted: true,
          newReference: result.newReference || null,
          version: result.version || null,
        });
      }

      const updates: any = {
        updated_at: new Date().toISOString(),
      };

      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (category !== undefined) updates.category = category;
      if (metadata !== undefined) updates.metadata = metadata;

      const { data, error } = await supabaseAdmin
        .from('requests')
        .update(updates)
        .eq('id', id)
        .eq('organization_id', organizationId)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Request not found' });
        }
        throw error;
      }

      await audit(req, session.user, {
        category: 'transaction',
        action: 'request.updated',
        targetType: 'request',
        targetId: id,
        requestId: id,
        targetLabel: (data as any)?.title || title || null,
        details: {
          actingFor: isEditAssistant
            ? (existing.metadata?.onBehalfOf?.userId || existing.creator_id)
            : undefined,
        },
      });

      return res.status(200).json({ request: data });
    }

    if (req.method === 'DELETE') {
      const userId = user.id;

      // First, fetch the request to verify ownership and status
      const { data: existingRequest, error: fetchError } = await supabaseAdmin
        .from('requests')
        .select('id, creator_id, status')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Request not found' });
        }
        throw fetchError;
      }

      // Check if user is the creator
      if (existingRequest.creator_id !== userId) {
        return res.status(403).json({ error: 'You can only delete your own requests' });
      }

      // Check if request is already approved - cannot delete approved requests
      if (existingRequest.status === 'approved') {
        return res.status(400).json({ error: 'Cannot delete an approved request' });
      }

      // Delete related records first (request_steps, approvals, documents)
      // Delete approvals for this request's steps
      const { data: steps } = await supabaseAdmin
        .from('request_steps')
        .select('id')
        .eq('request_id', id);

      if (steps && steps.length > 0) {
        const stepIds = steps.map(s => s.id);
        await supabaseAdmin
          .from('approvals')
          .delete()
          .in('step_id', stepIds);
      }

      // Delete request steps
      await supabaseAdmin
        .from('request_steps')
        .delete()
        .eq('request_id', id);

      // Delete documents
      await supabaseAdmin
        .from('documents')
        .delete()
        .eq('request_id', id);

      // Finally delete the request
      const { error } = await supabaseAdmin
        .from('requests')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (error) throw error;

      return res.status(200).json({ success: true, message: 'Request deleted successfully' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Request API error:', error);
    return res.status(500).json({ error: error.message || 'Failed to process request' });
  }
}
