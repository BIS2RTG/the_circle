import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { generateReferenceCode, getRequestTypeLabel } from '@/lib/requestCode';
import { buildAndNotifySteps } from '@/lib/requestSteps';
import { assertValidOnBehalf, isOnBehalf } from '@/lib/onBehalf';
import { createCapexTrackerRow } from '@/lib/capexTrackerHooks';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from '@/lib/rbac';
import { getUserAccessScope, scopeForResponse, AccessScope } from '@/lib/accessScope';
import { audit, auditApiError } from '@/lib/auditLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerSession(req, res, authOptions);
    
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const userId = user.id;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    if (req.method === 'GET') {
      const { status: statusFilter, type, limit = 50 } = req.query;

      // Audit/oversight scope: the Audit → Transactions page needs to list
      // EVERY request in the organisation, not just the ones the caller is
      // personally involved in. Gate this on the audit-view permission so it
      // can't be used to bypass normal request visibility.
      const rbacProfile = await getUserRBACProfile(userId);
      const wantsAuditScope = req.query.scope === 'audit';
      const canAuditView = wantsAuditScope && (
        hasPermission(rbacProfile, 'audit.view_logs') ||
        hasPermission(rbacProfile, PERMISSIONS.ADMIN_AUDIT_LOGS)
      );

      let query = supabaseAdmin
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
          creator:app_users!requests_creator_id_fkey (
            id,
            display_name,
            email,
            profile_picture_url
          ),
          request_steps (
            id,
            status,
            approver_user_id
          )
        `)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(canAuditView ? 1000 : 100); // Fetch more to filter down

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      } else {
        // By default, exclude drafts unless explicitly requested
        query = query.neq('status', 'draft');
      }

      const { data: requests, error } = await query;

      if (error) throw error;

      // Oversight visibility: users with requests.view_all see every request
      // that falls inside their data-access scope (business unit / department).
      const canViewAll = hasPermission(rbacProfile, 'requests.view_all');
      let accessScope: AccessScope | null = null;
      if (canViewAll) {
        accessScope = await getUserAccessScope(userId, rbacProfile);
      }

      const inScope = (req: any): boolean => {
        if (!accessScope) return false;
        if (accessScope.isOrgWide) return true;
        if (accessScope.level === 'own') return false;
        const unit = String(req.metadata?.unit || '').trim().toLowerCase();
        const buNames = accessScope.businessUnitNames.map(n => n.toLowerCase());
        if (accessScope.level === 'department') {
          const dept = String(req.metadata?.department || '').trim().toLowerCase();
          const deptName = (accessScope.departmentName || '').toLowerCase();
          if (!dept || !deptName || dept !== deptName) return false;
          if (unit && buNames.length > 0 && !buNames.includes(unit)) return false;
          return true;
        }
        return unit !== '' && buNames.includes(unit);
      };

      // APPROVAL VISIBILITY: Filter requests user can see
      // User can see if: creator, watcher, or approver with non-waiting step (or any step in parallel mode)
      const filteredRequests = (requests || []).filter((req: any) => {
        // Filter out drafts that don't belong to the current user
        if (req.status === 'draft') {
          return req.creator_id === userId;
        }

        // Audit oversight: an auditor querying ?scope=audit sees every
        // (non-draft) request in the organisation.
        if (canAuditView) return true;

        // Creator can always see their own requests
        if (req.creator_id === userId) return true;

        // Oversight: view_all within data scope
        if (canViewAll && inScope(req)) return true;
        
        // Check if user is a watcher
        const watcherIds = req.metadata?.watchers || [];
        const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
          typeof w === 'string' ? w === userId : w?.id === userId
        );
        if (isWatcher) return true;
        
        // Check if user is an approver
        const userStep = req.request_steps?.find(
          (step: any) => step.approver_user_id === userId
        );
        
        if (userStep) {
          // PARALLEL MODE: All approvers can see the request immediately (all steps are pending)
          // SEQUENTIAL MODE: Only approvers with non-waiting steps can see
          const isParallelApproval = req.metadata?.useParallelApprovals === true;
          if (isParallelApproval || userStep.status !== 'waiting') return true;
        }
        
        return false;
      }).slice(0, Number(limit));

      // Helper function to compute actual status based on step statuses
      const computeActualStatus = (dbStatus: string, steps: any[]) => {
        if (!steps || steps.length === 0) return dbStatus;
        
        // If any step is rejected, the request is rejected
        if (steps.some((s: any) => s.status === 'rejected')) return 'rejected';
        
        // If all steps are approved, the request is approved
        if (steps.every((s: any) => s.status === 'approved')) return 'approved';
        
        // If there are pending or waiting steps, the request is still in progress
        if (steps.some((s: any) => s.status === 'pending' || s.status === 'waiting')) return 'pending';
        
        return dbStatus;
      };

      // Transform data to match frontend Request interface
      const transformedRequests = filteredRequests.map((req: any) => ({
        id: req.id,
        title: req.title,
        description: req.description || '',
        status: computeActualStatus(req.status, req.request_steps),
        priority: req.metadata?.priority || 'normal',
        category: req.metadata?.category || req.metadata?.requestType || 'General',
        department: req.creator?.department || req.metadata?.department || 'Unknown',
        created_at: req.created_at,
        updated_at: req.updated_at,
        current_step: req.metadata?.current_step || 1,
        total_steps: req.metadata?.total_steps || 1,
        type: req.metadata?.requestType || 'approval',
        amount: req.metadata?.amount,
        currency: req.metadata?.currency || 'USD',
        requester: {
          id: req.creator?.id || '',
          name: req.creator?.display_name || 'Unknown User',
          email: req.creator?.email || '',
          avatar: req.creator?.profile_picture_url || null,
          department: req.creator?.department || req.metadata?.department || 'Unknown',
          position: req.creator?.position || req.metadata?.position || '',
        },
        current_approver: req.metadata?.current_approver,
        due_date: req.metadata?.due_date,
        reference_number: req.metadata?.reference_number || `REQ-${req.id?.substring(0, 8)?.toUpperCase() || ''}`,
        attachments_count: req.metadata?.attachments_count || 0,
        comments_count: req.metadata?.comments_count || 0,
      }));

      return res.status(200).json({
        requests: transformedRequests,
        scope: accessScope ? scopeForResponse(accessScope) : null,
      });
    }

    if (req.method === 'POST') {
      const { 
        title, 
        description, 
        priority = 'medium', 
        requestType,
        metadata = {},
        status: requestStatus
      } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'Title is required' });
      }

      // Voucher requests are gated: only users with `vouchers.create` (or a
      // super admin) may raise them.
      const isVoucherRequest = requestType === 'voucher_request' || metadata?.type === 'voucher_request';
      if (isVoucherRequest) {
        const voucherProfile = await getUserRBACProfile(userId);
        if (!hasPermission(voucherProfile, PERMISSIONS.VOUCHERS_CREATE)) {
          return res.status(403).json({ error: 'You do not have permission to create vouchers' });
        }
      }

      // Allow draft or pending status, default to draft
      const validStatuses = ['draft', 'pending'];
      const finalStatus = validStatuses.includes(requestStatus) ? requestStatus : 'draft';

      // File-on-behalf-of guard: never trust the client's beneficiary. Re-verify
      // the beneficiary is an executive the filer holds an active delegation from.
      const onBehalfResult = await assertValidOnBehalf(organizationId, userId, metadata?.onBehalfOf);
      if (!onBehalfResult.ok) {
        return res.status(403).json({ error: onBehalfResult.error });
      }

      // Store priority and requestType in metadata
      // Preserve existing referenceCode if re-used (e.g. from a converted draft), otherwise generate one.
      const finalMetadata = {
        ...metadata,
        priority,
        requestType: requestType || 'general',
        referenceCode: (metadata && typeof metadata.referenceCode === 'string' && metadata.referenceCode)
          ? metadata.referenceCode
          : generateReferenceCode(requestType),
        // Persist only the server-verified beneficiary (or drop it entirely).
        onBehalfOf: onBehalfResult.normalized ?? null,
      };

      const { data, error } = await supabaseAdmin
        .from('requests')
        .insert({
          organization_id: organizationId,
          creator_id: userId,
          title,
          description: description || null,
          metadata: finalMetadata,
          status: finalStatus,
        })
        .select()
        .single();

      if (error) throw error;

      // Turn the picked approvers into request_steps + notifications. This is the
      // single source of truth for form requests, shared with /publish and the
      // resubmit-after-unsubmit path (see lib/requestSteps.ts).
      let submitted = false;
      if (finalStatus === 'pending') {
        const stepResult = await buildAndNotifySteps({
          requestId: data.id,
          organizationId,
          creatorId: userId,
          title,
          metadata: finalMetadata,
          requestType,
        });

        if (!stepResult.success) {
          // Preserve the user's work: demote to draft and report why it couldn't submit.
          await supabaseAdmin.from('requests').update({ status: 'draft' }).eq('id', data.id);
          return res.status(400).json({ error: stepResult.error, request: { ...data, status: 'draft' } });
        }
        submitted = true;
      }

      // CAPEX Tracker side-effect: create a tracker row on submission
      // Fails silently — never blocks the request creation path
      if (submitted && (finalMetadata.type === 'capex' || finalMetadata.requestType === 'capex')) {
        try {
          await createCapexTrackerRow(data.id, organizationId, userId);
        } catch (trackerErr) {
          console.error('Failed to create CAPEX tracker row:', trackerErr);
        }
      }

      // Voucher register side-effect: create a pending booklet row on submission
      // so the voucher can be tracked before approval. The sequential number and
      // email fulfilment are filled in on final approval. Fails silently.
      if (submitted && isVoucherRequest) {
        try {
          await supabaseAdmin
            .from('vouchers')
            .upsert({
              organization_id: organizationId,
              request_id: data.id,
              guest_names: finalMetadata.guestNames || null,
              business_units: finalMetadata.selectedBusinessUnits || [],
              reason: finalMetadata.reason || description || null,
              created_by: userId,
            }, { onConflict: 'request_id' });
        } catch (voucherErr) {
          console.error('Failed to create voucher register row:', voucherErr);
        }
      }

      // Notify watchers if any (only once the request is actually submitted)
      if (submitted && metadata?.watchers?.length > 0) {
        const watchers = metadata.watchers as string[];
        
        // Get the requester's name for the notification (if not already fetched)
        let requesterName = 'A user';
        const { data: requesterData } = await supabaseAdmin
          .from('app_users')
          .select('display_name')
          .eq('id', userId)
          .single();
        
        if (requesterData?.display_name) {
          requesterName = requesterData.display_name;
        }

        // Create notifications for all watchers
        const watcherNotifications = watchers.map((watcherId: string) => ({
          organization_id: organizationId,
          recipient_id: watcherId,
          sender_id: userId,
          type: 'info',
          title: 'Added as Watcher',
          message: `${requesterName} has added you as a watcher on their ${getRequestTypeLabel(requestType || metadata?.type)} request "${title}".`,
          metadata: {
            request_id: data.id,
            request_type: requestType,
            action_label: 'View Request',
            action_url: `/requests/${data.id}`,
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

      await audit(req, session.user, {
        category: 'transaction',
        action: 'request.created',
        targetType: 'request',
        targetId: data.id,
        targetLabel: title,
        requestId: data.id,
        details: { requestType: requestType || null, status: data.status },
      });

      // Distinct, filterable event when this was filed on someone's behalf.
      const beneficiary = finalMetadata.onBehalfOf as { userId?: string; name?: string; external?: boolean; company?: string } | null;
      if (isOnBehalf(beneficiary)) {
        await audit(req, session.user, {
          category: 'transaction',
          action: 'request.filed_on_behalf',
          targetType: 'request',
          targetId: data.id,
          targetLabel: title,
          requestId: data.id,
          details: {
            principalId: beneficiary?.userId || null,
            principalName: beneficiary?.name || null,
            // External beneficiaries have no account, so the audit trail is the
            // only record of who the request was actually for.
            principalExternal: beneficiary?.external === true,
            principalCompany: beneficiary?.company || null,
            requestType: requestType || null,
          },
        });
      }

      return res.status(201).json({ request: data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Requests API error:', error);
    await auditApiError(req, 'system.error.requests_api', error);
    return res.status(500).json({ error: error.message || 'Failed to process request' });
  }
}
