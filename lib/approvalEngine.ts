/**
 * Data-Driven Approval Engine
 * 
 * This is the core engine that processes approval workflows.
 * Workflows are stored as data in the database, not as code.
 * 
 * Key concepts:
 * - WorkflowDefinition: The template/blueprint stored in DB
 * - WorkflowInstance: A running instance (the request + its steps)
 * - ApprovalEngine: The processor that executes the workflow logic
 */

import { supabaseAdmin } from './supabaseAdmin';
import { generateAndStoreArchive } from '@/pages/api/archives/generate-pdf';
import { syncApprovedPdfToMicrosoft } from '@/lib/graphDocumentUpload';
import { recordAuditEvent } from '@/lib/auditLog';
import {
  resolveApprovalChainFromOrganogram,
  findEmployeeByPositionTitle,
} from './hrimsClient';
import { onCapexApproved, onCapexRejected, onCapexResubmitted, onCapexCancelled } from './capexTrackerHooks';
import { autoCreatePettyCashFromTravelAuth } from './autoPettyCash';
import { sendUserNotificationEmail, escapeHtml, appBaseUrl } from './notificationEmail';
import { approvalLinkUrl } from './approvalLinkToken';
import { getUserPreferences } from './userPreferences';
import { getActiveDelegateFor } from './delegations';
import { assistantCanActOn, fanoutToNotificationAssistants } from './assistantAssignments';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowStepDefinition {
  id: string;
  name: string;
  order: number;
  type: 'approval' | 'notification' | 'integration' | 'condition';
  
  // Approver configuration
  approverType: 'specific_user' | 'role' | 'department_head' | 'manager' | 'dynamic_field' | 'organogram_position' | 'organogram_supervisor';
  approverValue?: string; // user_id, role_name, or field_name depending on approverType
  
  // Conditions for when this step should execute
  conditions?: StepCondition[];
  
  // Step-specific settings
  settings?: {
    requireComment?: boolean;
    autoApprove?: {
      enabled: boolean;
      condition: string;
      value: string;
    };
    escalation?: {
      enabled: boolean;
      hours: number;
      escalateTo?: string;
    };
    notifications?: {
      onAssignment: boolean;
      onApproval: boolean;
      onRejection: boolean;
    };
  };
  
  // For parallel approvals
  isParallel?: boolean;
  parallelGroup?: string;
  
  // Integration config (for notification/integration steps)
  integration?: {
    provider: 'email' | 'teams' | 'slack' | 'webhook';
    action: string;
    config: Record<string, any>;
  };
}

export interface StepCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'between' | 'in';
  value: string | number;
  value2?: string | number; // For 'between' operator
}

export interface WorkflowDefinition {
  id: string;
  organization_id: string;
  name: string;
  description?: string;
  category?: string;
  form_schema: FormField[];
  steps: WorkflowStepDefinition[];
  settings: WorkflowSettings;
  is_active: boolean;
  version: number;
}

export interface FormField {
  id: string;
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'file' | 'currency';
  required: boolean;
  options?: { label: string; value: string }[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface WorkflowSettings {
  allowParallelApprovals: boolean;
  requireAllParallel: boolean;
  allowSkipSteps: boolean;
  allowReassignment: boolean;
  expirationDays: number;
  onExpiration: 'escalate' | 'auto_approve' | 'auto_reject' | 'notify';
  notifyRequesterOnEachStep: boolean;
  allowWithdraw: boolean;
  requireAttachments: boolean;
}

export interface WorkflowInstance {
  requestId: string;
  workflowDefinitionId: string;
  organizationId: string;
  creatorId: string;
  formData: Record<string, any>;
  currentStepIndex: number;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
}

export interface StepInstance {
  id: string;
  requestId: string;
  stepIndex: number;
  stepDefinition: WorkflowStepDefinition;
  approverId: string | null;
  status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';
  dueAt?: string;
}

// ============================================================================
// Approval Engine Class
// ============================================================================

export class ApprovalEngine {
  
  /**
   * Get a workflow definition by ID
   */
  static async getWorkflowDefinition(workflowId: string): Promise<WorkflowDefinition | null> {
    const { data, error } = await supabaseAdmin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowId)
      .eq('is_active', true)
      .single();
    
    if (error || !data) {
      console.error('Failed to fetch workflow definition:', error);
      return null;
    }
    
    return data as WorkflowDefinition;
  }
  
  /**
   * Get all active workflow definitions for an organization
   */
  static async getWorkflowDefinitions(organizationId: string): Promise<WorkflowDefinition[]> {
    const { data, error } = await supabaseAdmin
      .from('workflow_definitions')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('name');
    
    if (error) {
      console.error('Failed to fetch workflow definitions:', error);
      return [];
    }
    
    return (data || []) as WorkflowDefinition[];
  }
  
  /**
   * Create a new request from a workflow definition
   * This is the main entry point for starting a workflow
   */
  static async createRequest(
    workflowDefinitionId: string,
    organizationId: string,
    creatorId: string,
    title: string,
    description: string | null,
    formData: Record<string, any>,
    status: 'draft' | 'pending' = 'draft'
  ): Promise<{ success: boolean; requestId?: string; error?: string }> {
    
    // 1. Fetch the workflow definition
    const workflow = await this.getWorkflowDefinition(workflowDefinitionId);
    if (!workflow) {
      return { success: false, error: 'Workflow definition not found' };
    }
    
    // 2. Create the request record
    const { data: request, error: requestError } = await supabaseAdmin
      .from('requests')
      .insert({
        organization_id: organizationId,
        workflow_definition_id: workflowDefinitionId,
        creator_id: creatorId,
        title,
        description,
        status,
        metadata: {
          ...formData,
          workflow_name: workflow.name,
          workflow_category: workflow.category,
          total_steps: workflow.steps.filter(s => s.type === 'approval').length,
        },
      })
      .select()
      .single();
    
    if (requestError || !request) {
      console.error('Failed to create request:', requestError);
      return { success: false, error: 'Failed to create request' };
    }
    
    // 3. If submitting (not draft), create the workflow steps
    if (status === 'pending') {
      const stepsResult = await this.initializeWorkflowSteps(
        request.id,
        workflow,
        formData,
        organizationId,
        creatorId
      );
      
      if (!stepsResult.success) {
        // Rollback: delete the request
        await supabaseAdmin.from('requests').delete().eq('id', request.id);
        return { success: false, error: stepsResult.error };
      }
    }
    
    return { success: true, requestId: request.id };
  }
  
  /**
   * Initialize workflow steps for a request
   */
  static async initializeWorkflowSteps(
    requestId: string,
    workflow: WorkflowDefinition,
    formData: Record<string, any>,
    organizationId: string,
    creatorId: string
  ): Promise<{ success: boolean; error?: string }> {
    
    const approvalSteps = workflow.steps.filter(s => s.type === 'approval');
    const stepsToCreate: any[] = [];
    
    // Check if parallel approvals mode is enabled
    const useParallelApprovals = formData?.useParallelApprovals === true;
    
    for (let i = 0; i < approvalSteps.length; i++) {
      const stepDef = approvalSteps[i];
      
      // Check if step conditions are met
      if (stepDef.conditions && stepDef.conditions.length > 0) {
        const shouldInclude = this.evaluateConditions(stepDef.conditions, formData);
        if (!shouldInclude) {
          continue; // Skip this step
        }
      }
      
      // Resolve the approver
      const approverId = await this.resolveApprover(
        stepDef,
        formData,
        organizationId,
        creatorId
      );
      
      if (!approverId && stepDef.type === 'approval') {
        return {
          success: false,
          error: `Could not resolve approver for step: ${stepDef.name}`
        };
      }

      // Delegation: if an active delegation covers this approver, route the
      // step to the delegate and stamp the redirect columns so the workflow
      // timeline shows it as delegated (and links back to the delegation).
      let effectiveApproverId = approverId;
      let delegationFields: Record<string, any> = {};
      if (approverId) {
        const delegation = await getActiveDelegateFor(approverId, organizationId);
        if (delegation) {
          effectiveApproverId = delegation.delegate_id;
          delegationFields = {
            is_redirected: true,
            original_approver_id: approverId,
            redirected_by_id: delegation.created_by,
            redirected_at: new Date().toISOString(),
            redirect_reason: delegation.reason,
            delegation_id: delegation.id,
          };
        }
      }

      // Calculate due date if escalation is configured
      let dueAt: string | null = null;
      if (stepDef.settings?.escalation?.enabled && stepDef.settings.escalation.hours) {
        const dueDate = new Date();
        dueDate.setHours(dueDate.getHours() + stepDef.settings.escalation.hours);
        dueAt = dueDate.toISOString();
      }

      // PARALLEL: All steps are pending; SEQUENTIAL: Only first step is pending
      const isPendingNow = useParallelApprovals || stepsToCreate.length === 0;
      stepsToCreate.push({
        request_id: requestId,
        step_index: stepsToCreate.length + 1,
        step_type: stepDef.type,
        approver_user_id: effectiveApproverId,
        approver_role: stepDef.approverType === 'role' ? stepDef.approverValue : null,
        status: isPendingNow ? 'pending' : 'waiting',
        // "Received on this approver's desk" — stamped when the step is active.
        activated_at: isPendingNow ? new Date().toISOString() : null,
        due_at: dueAt,
        step_definition: stepDef, // Store the step config snapshot
        ...delegationFields,
      });
    }
    
    if (stepsToCreate.length === 0) {
      return { success: false, error: 'No approval steps could be created' };
    }
    
    // Insert all steps
    const { error: stepsError } = await supabaseAdmin
      .from('request_steps')
      .insert(stepsToCreate);
    
    if (stepsError) {
      console.error('Failed to create request steps:', stepsError);
      return { success: false, error: 'Failed to create approval steps' };
    }
    
    if (useParallelApprovals) {
      // PARALLEL: Notify ALL approvers immediately
      for (const step of stepsToCreate) {
        await this.notifyApprover(
          requestId,
          step.approver_user_id,
          organizationId,
          creatorId,
          `New approval request requires your attention (Parallel approval - ${stepsToCreate.length} approvers)`
        );
      }
    } else {
      // SEQUENTIAL: Notify only the first approver
      await this.notifyApprover(
        requestId,
        stepsToCreate[0].approver_user_id,
        organizationId,
        creatorId,
        'New approval request requires your attention'
      );
    }
    
    return { success: true };
  }
  
  /**
   * Resolve the approver for a step based on approverType
   */
  static async resolveApprover(
    stepDef: WorkflowStepDefinition,
    formData: Record<string, any>,
    organizationId: string,
    creatorId: string
  ): Promise<string | null> {
    
    switch (stepDef.approverType) {
      case 'specific_user':
        return stepDef.approverValue || null;
      
      case 'role':
        // Find a user with this role in the organization
        const { data: roleUser } = await supabaseAdmin
          .from('app_users')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('role', stepDef.approverValue)
          .limit(1)
          .single();
        return roleUser?.id || null;
      
      case 'department_head':
        // Get the creator's department, then find the department head
        const { data: creator } = await supabaseAdmin
          .from('app_users')
          .select('department_id')
          .eq('id', creatorId)
          .single();
        
        if (creator?.department_id) {
          const { data: deptHead } = await supabaseAdmin
            .from('app_users')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('department_id', creator.department_id)
            .eq('is_department_head', true)
            .limit(1)
            .single();
          return deptHead?.id || null;
        }
        return null;
      
      case 'manager':
        // Get the creator's manager
        const { data: creatorWithManager } = await supabaseAdmin
          .from('app_users')
          .select('manager_id')
          .eq('id', creatorId)
          .single();
        return creatorWithManager?.manager_id || null;
      
      case 'dynamic_field':
        // The approver is specified in a form field
        const fieldName = stepDef.approverValue;
        if (fieldName && formData[fieldName]) {
          return formData[fieldName];
        }
        return null;
      
      case 'organogram_position':
        // Resolve by position title from HRIMS organogram
        // approverValue = position title (e.g. "Human Resources Director", "Finance Director")
        try {
          const positionTitle = stepDef.approverValue;
          if (!positionTitle) return null;
          
          const result = await findEmployeeByPositionTitle(
            positionTitle,
            formData?.business_unit_id // optional: scope to a specific business unit
          );
          
          if (result?.employee?.email) {
            // Match HRIMS employee email to the_circle app_users
            const { data: matchedUser } = await supabaseAdmin
              .from('app_users')
              .select('id')
              .eq('email', result.employee.email)
              .limit(1)
              .single();
            return matchedUser?.id || null;
          }
          return null;
        } catch (err) {
          console.error('Failed to resolve organogram_position approver:', err);
          return null;
        }
      
      case 'organogram_supervisor':
        // Walk up the organogram from the requester to find their Nth supervisor
        // approverValue = supervisor level (e.g. "1" for direct supervisor, "2" for their supervisor's supervisor)
        try {
          // Get the requester's email from app_users
          const { data: requester } = await supabaseAdmin
            .from('app_users')
            .select('email')
            .eq('id', creatorId)
            .single();
          
          if (!requester?.email) return null;
          
          const chain = await resolveApprovalChainFromOrganogram(requester.email);
          const supervisorLevel = parseInt(stepDef.approverValue || '1', 10) - 1;
          
          if (chain.length > supervisorLevel && chain[supervisorLevel]?.employee?.email) {
            // Match HRIMS employee email to the_circle app_users
            const { data: supervisorUser } = await supabaseAdmin
              .from('app_users')
              .select('id')
              .eq('email', chain[supervisorLevel].employee.email)
              .limit(1)
              .single();
            return supervisorUser?.id || null;
          }
          return null;
        } catch (err) {
          console.error('Failed to resolve organogram_supervisor approver:', err);
          return null;
        }
      
      default:
        return null;
    }
  }
  
  /**
   * Evaluate conditions against form data
   */
  static evaluateConditions(
    conditions: StepCondition[],
    formData: Record<string, any>
  ): boolean {
    if (!conditions || conditions.length === 0) {
      return true;
    }
    
    return conditions.every(condition => {
      const fieldValue = formData[condition.field];
      const targetValue = condition.value;
      const targetValue2 = condition.value2;
      
      switch (condition.operator) {
        case 'equals':
          return String(fieldValue) === String(targetValue);
        case 'not_equals':
          return String(fieldValue) !== String(targetValue);
        case 'greater_than':
          return Number(fieldValue) > Number(targetValue);
        case 'less_than':
          return Number(fieldValue) < Number(targetValue);
        case 'contains':
          return String(fieldValue).toLowerCase().includes(String(targetValue).toLowerCase());
        case 'between':
          const num = Number(fieldValue);
          return num >= Number(targetValue) && num <= Number(targetValue2 || targetValue);
        case 'in':
          const values = String(targetValue).split(',').map(v => v.trim());
          return values.includes(String(fieldValue));
        default:
          return true;
      }
    });
  }
  
  /**
   * Process an approval action (approve/reject).
   *
   * The `audit` bag captures the forensic context of a risk-based approval:
   * which signature the user applied, how they were authenticated, their
   * network/device, etc. All fields are optional so legacy call sites
   * continue to work; new callers should pass `audit` to populate the
   * extended columns added by `extend_approvals_audit_trail.sql`.
   */
  static async processApprovalAction(
    requestId: string,
    stepId: string,
    userId: string,
    action: 'approve' | 'reject',
    comment?: string,
    signatureUrl?: string,
    audit?: {
      signatureType?: 'saved' | 'manual' | 'typed';
      signatureReference?: string | null;
      authenticationMethod?: 'session' | 'microsoft_mfa' | 'biometric';
      riskLevel?: 'low' | 'medium' | 'high';
      authReference?: string | null;
      ipAddress?: string | null;
      deviceInfo?: Record<string, any> | null;
    }
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    
    if (!supabaseAdmin) {
      console.error('supabaseAdmin is not initialized');
      return { success: false, error: 'Database connection not available' };
    }
    
    // 1. Verify the step belongs to this user and is actionable
    console.log('Looking up step:', { stepId, requestId, userId });
    
    // First, try to find the step by ID only to debug
    const { data: stepById, error: stepByIdError } = await supabaseAdmin
      .from('request_steps')
      .select('id, request_id, approver_user_id, status')
      .eq('id', stepId)
      .single();
    
    if (stepByIdError) {
      console.error('Step lookup by ID only failed:', JSON.stringify(stepByIdError, null, 2));
    } else {
      console.log('Step found by ID:', stepById);
      if (stepById.request_id !== requestId) {
        console.error('Request ID mismatch! Step belongs to:', stepById.request_id, 'but got:', requestId);
      }
    }
    
    const { data: step, error: stepError } = await supabaseAdmin
      .from('request_steps')
      .select('*')
      .eq('id', stepId)
      .eq('request_id', requestId)
      .single();
    
    if (stepError) {
      console.error('Step lookup error:', JSON.stringify(stepError, null, 2));
      // PGRST116 means no rows found
      if (stepError.code === 'PGRST116') {
        return { success: false, error: 'Approval step not found - step may not exist or does not belong to this request' };
      }
      return { success: false, error: `Database error: ${stepError.message}` };
    }
    
    if (!step) {
      console.error('Step not found - no data returned');
      return { success: false, error: 'Approval step not found' };
    }
    
    console.log('Found step:', { id: step.id, status: step.status, approver: step.approver_user_id });
    
    if (step.approver_user_id !== userId) {
      return { success: false, error: 'You are not authorized to act on this approval' };
    }
    
    if (step.status !== 'pending' && step.status !== 'waiting') {
      return { success: false, error: 'This approval step is no longer pending' };
    }
    
    // Check if previous steps are completed (for waiting status)
    if (step.status === 'waiting') {
      const { data: previousSteps } = await supabaseAdmin
        .from('request_steps')
        .select('status')
        .eq('request_id', requestId)
        .lt('step_index', step.step_index);
      
      const allPreviousApproved = !previousSteps || previousSteps.every(s => s.status === 'approved');
      if (!allPreviousApproved) {
        return { success: false, error: 'Previous approval steps must be completed first' };
      }
    }
    
    // Check if comment is required
    const stepDef = step.step_definition as WorkflowStepDefinition | null;
    if (action === 'reject' && !comment?.trim()) {
      return { success: false, error: 'Comment is required for rejection' };
    }
    if (stepDef?.settings?.requireComment && !comment?.trim()) {
      return { success: false, error: 'Comment is required for this step' };
    }
    
    const decision = action === 'approve' ? 'approved' : 'rejected';
    
    // 2. Record the approval decision.
    //    Legacy columns (signature_url) are preserved for backward
    //    compatibility with readers that predate the audit-trail extension;
    //    the new columns capture the risk-based-auth context.
    const { error: approvalError } = await supabaseAdmin
      .from('approvals')
      .insert({
        request_id: requestId,
        step_id: stepId,
        approver_id: userId,
        decision,
        comment: comment || null,
        signature_url: signatureUrl || null,
        // --- extended audit trail (all optional, safe to be null) ---
        signature_type: audit?.signatureType || null,
        signature_reference: audit?.signatureReference ?? signatureUrl ?? null,
        authentication_method: audit?.authenticationMethod || null,
        risk_level: audit?.riskLevel || null,
        auth_reference: audit?.authReference || null,
        ip_address: audit?.ipAddress || null,
        device_info: audit?.deviceInfo || {},
        signed_at: new Date().toISOString(),
      });
    
    if (approvalError) {
      console.error('Failed to create approval record:', approvalError);
      return { success: false, error: 'Failed to record approval decision' };
    }
    
    // 3. Update step status
    await supabaseAdmin
      .from('request_steps')
      .update({ status: decision })
      .eq('id', stepId);
    
    // 4. Handle next steps based on action
    if (action === 'approve') {
      return await this.handleApproval(requestId, step, userId, comment);
    } else {
      return await this.handleRejection(requestId, step, userId, comment);
    }
  }
  
  /**
   * Handle approval - activate next step or complete workflow
   */
  private static async handleApproval(
    requestId: string,
    currentStep: any,
    approverId: string,
    comment?: string
  ): Promise<{ success: boolean; message?: string }> {

    // Get request details for notification and to check parallel mode
    const { data: request } = await supabaseAdmin
      .from('requests')
      .select('title, organization_id, creator_id, metadata')
      .eq('id', requestId)
      .single();

    // Get approver name + role for the notification message. Role/job title
    // makes the update legible to the requester ("approved by Jane Smith,
    // Finance Director") without forcing them to open the request.
    const { data: approver } = await supabaseAdmin
      .from('app_users')
      .select('display_name, job_title, role')
      .eq('id', approverId)
      .single();

    const approverName = approver?.display_name || 'an approver';
    const approverRole = approver?.job_title || approver?.role || null;
    const approverLabel = approverRole ? `${approverName} (${approverRole})` : approverName;
    const stepLabel = formatStepLabel(currentStep);
    const requestRef = (request?.metadata as any)?.referenceCode || (request?.title || 'your request');
    const trimmedComment = (comment || '').trim();
    const commentSuffix = trimmedComment ? `\n\nComment: "${truncate(trimmedComment, 240)}"` : '';
    const isParallelApproval = request?.metadata?.useParallelApprovals === true;
    
    if (isParallelApproval) {
      // PARALLEL APPROVAL MODE: Check if all steps are now approved
      const { data: allSteps } = await supabaseAdmin
        .from('request_steps')
        .select('id, status')
        .eq('request_id', requestId);
      
      const pendingSteps = allSteps?.filter(s => s.status === 'pending') || [];
      const approvedSteps = allSteps?.filter(s => s.status === 'approved') || [];
      const totalSteps = allSteps?.length || 0;
      
      // Notify the requestor about this approval
      const requestType = request?.metadata?.type || request?.metadata?.requestType;
      if (request) {
        await this.notifyRequester(
          requestId,
          request.creator_id,
          request.organization_id,
          `${approverLabel} approved ${requestRef} — ${approvedSteps.length} of ${totalSteps} parallel approvals received.${commentSuffix}`,
          requestType,
          { title: `Approval received (${approvedSteps.length}/${totalSteps})`, senderId: approverId }
        );
      }

      if (pendingSteps.length === 0) {
        // All approvers have approved - complete the workflow
        await supabaseAdmin
          .from('requests')
          .update({ status: 'approved' })
          .eq('id', requestId);

        if (request) {
          await this.notifyRequester(
            requestId,
            request.creator_id,
            request.organization_id,
            `Your request ${requestRef} has been fully approved. All ${totalSteps} approvers have signed off — the request is now finalised and the approved document is available to download.`,
            requestType,
            { title: 'Request fully approved', senderId: approverId, sendEmail: false }
          );

          // On-behalf: notify the principal exactly once — only now, on full
          // approval. Throughout the flow the assistant (creator) got the
          // progress updates; this is the principal's single notification.
          await this.notifyOnBehalfPrincipalOnApproval(requestId, request, requestRef, requestType, approverId);

          // Travel-auth: prompt requester to optionally process a petty cash voucher.
          await this.maybeNotifyPettyCashCta(requestId, request, requestType);

          // Auto-generate and store PDF archive, then push it to Microsoft 365
          // (Teams channel + SharePoint). Both are best-effort.
          try {
            const archiveResult = await generateAndStoreArchive(requestId, request.organization_id, approverId);
            console.log(`Archive generated for request ${requestId}`);
            await this.pushApprovedPdfToMicrosoft(requestId, request, archiveResult);
          } catch (archiveError) {
            console.error('Failed to generate archive:', archiveError);
          }

          // CAPEX Tracker: flip status to awaiting funding. Safe for all types — hook guards internally.
          await onCapexApproved(requestId, approverId);

          // Price Variation: if this was a variation raised against an approved
          // CAPEX, stamp + notify the parent. No-op for other request types.
          await this.linkPriceVariationToParent(requestId, request, approverId);
        }

        return { success: true, message: 'Request fully approved (parallel)' };
      }
      
      return { success: true, message: `Approved (${approvedSteps.length}/${totalSteps} approvals)` };
    }
    
    // SEQUENTIAL APPROVAL MODE (original logic)
    // Get the next step
    const { data: nextStep } = await supabaseAdmin
      .from('request_steps')
      .select('id, approver_user_id, status, delegation_id')
      .eq('request_id', requestId)
      .eq('step_index', currentStep.step_index + 1)
      .single();

    if (nextStep && nextStep.status === 'waiting') {
      // Delegation: if an active delegation now covers the next approver,
      // route this step to the delegate as it becomes actionable. Skip steps
      // already stamped with a delegation (created during the window).
      let nextApproverId = nextStep.approver_user_id;
      // Stamp activated_at so the SLA clock + timeline measure time on THIS
      // approver's desk (from now), not from when the request was first created.
      const activation: Record<string, any> = { status: 'pending', activated_at: new Date().toISOString() };
      if (nextApproverId && !nextStep.delegation_id) {
        const delegation = await getActiveDelegateFor(nextApproverId, request?.organization_id);
        if (delegation && delegation.delegate_id !== nextApproverId) {
          activation.approver_user_id = delegation.delegate_id;
          activation.is_redirected = true;
          activation.original_approver_id = nextApproverId;
          activation.redirected_by_id = delegation.created_by;
          activation.redirected_at = new Date().toISOString();
          activation.redirect_reason = delegation.reason;
          activation.delegation_id = delegation.id;
          nextApproverId = delegation.delegate_id;
        }
      }

      // Activate the next step - SEQUENTIAL APPROVAL
      await supabaseAdmin
        .from('request_steps')
        .update(activation)
        .eq('id', nextStep.id);
      
      // Update current_step in request metadata
      const { data: currentRequest } = await supabaseAdmin
        .from('requests')
        .select('metadata')
        .eq('id', requestId)
        .single();
      
      if (currentRequest) {
        await supabaseAdmin
          .from('requests')
          .update({
            metadata: {
              ...currentRequest.metadata,
              current_step: currentStep.step_index + 1,
            }
          })
          .eq('id', requestId);
      }
      
      if (request && nextApproverId) {
        // Get total steps for the notification message
        const { count: totalSteps } = await supabaseAdmin
          .from('request_steps')
          .select('id', { count: 'exact', head: true })
          .eq('request_id', requestId);

        const nextStepNumber = currentStep.step_index + 1;
        const stepsInfo = totalSteps ? ` (Step ${nextStepNumber} of ${totalSteps})` : '';

        // SEQUENTIAL NOTIFICATION: Notify the next approver only when their turn comes
        await this.notifyApprover(
          requestId,
          nextApproverId,
          request.organization_id,
          approverId,
          `Request "${request.title}" is ready for your approval${stepsInfo}`
        );

        // Resolve the next approver's name so the requester can see who they're waiting on.
        const { data: nextApprover } = await supabaseAdmin
          .from('app_users')
          .select('display_name, job_title')
          .eq('id', nextApproverId)
          .single();
        const nextApproverName = nextApprover?.display_name || 'the next approver';
        const nextApproverLabel = nextApprover?.job_title
          ? `${nextApproverName} (${nextApprover.job_title})`
          : nextApproverName;

        // Notify the requestor about this step approval — include who approved,
        // their role, the step in the chain, any comment, and who is up next.
        const requestType = request.metadata?.type || request.metadata?.requestType;
        const currentNum = currentStep.step_index;
        const stepFrame = totalSteps ? `step ${currentNum} of ${totalSteps}` : `step ${currentNum}`;
        await this.notifyRequester(
          requestId,
          request.creator_id,
          request.organization_id,
          `${approverLabel} approved ${requestRef} at ${stepFrame}${stepLabel ? ` (${stepLabel})` : ''}. Now awaiting ${nextApproverLabel}.${commentSuffix}`,
          requestType,
          { title: `Step ${currentNum} approved — awaiting ${nextApproverName}`, senderId: approverId }
        );
      }
      
      return { success: true, message: 'Approved - next approver notified' };
    }
    
    // Check if all steps are completed
    const { data: incompleteSteps } = await supabaseAdmin
      .from('request_steps')
      .select('id')
      .eq('request_id', requestId)
      .in('status', ['pending', 'waiting']);
    
    if (!incompleteSteps || incompleteSteps.length === 0) {
      // All steps approved - complete the workflow
      await supabaseAdmin
        .from('requests')
        .update({ status: 'approved' })
        .eq('id', requestId);

      // Notify the requester (request already fetched above)
      if (request) {
        const requestType = request.metadata?.type || request.metadata?.requestType;
        await this.notifyRequester(
          requestId,
          request.creator_id,
          request.organization_id,
          `Your request ${requestRef} has been fully approved. Final sign-off by ${approverLabel}. The approved document is available to preview and download.${commentSuffix}`,
          requestType,
          { title: 'Request fully approved', senderId: approverId, sendEmail: false }
        );

        // On-behalf: notify the principal exactly once — only now, on full
        // approval. Throughout the flow the assistant (creator) got the
        // progress updates; this is the principal's single notification.
        await this.notifyOnBehalfPrincipalOnApproval(requestId, request, requestRef, requestType, approverId);

        // Travel-auth: prompt requester to optionally process a petty cash voucher.
        await this.maybeNotifyPettyCashCta(requestId, request, requestType);

        // Auto-generate and store PDF archive, then push it to Microsoft 365
        // (Teams channel + SharePoint). Both are best-effort.
        try {
          const archiveResult = await generateAndStoreArchive(requestId, request.organization_id, approverId);
          console.log(`Archive generated for request ${requestId}`);
          await this.pushApprovedPdfToMicrosoft(requestId, request, archiveResult);
        } catch (archiveError) {
          console.error('Failed to generate archive:', archiveError);
        }

        // CAPEX Tracker: flip status to awaiting funding. Safe for all types — hook guards internally.
        await onCapexApproved(requestId, approverId);

        // Price Variation: if this was a variation raised against an approved
        // CAPEX, stamp + notify the parent. No-op for other request types.
        await this.linkPriceVariationToParent(requestId, request, approverId);
      }

      return { success: true, message: 'Request fully approved' };
    }
    
    return { success: true, message: 'Approved' };
  }
  
  /**
   * Handle rejection - reject the entire request
   */
  private static async handleRejection(
    requestId: string,
    currentStep: any,
    rejecterId: string,
    comment?: string
  ): Promise<{ success: boolean; message?: string }> {

    // Update request status to rejected
    await supabaseAdmin
      .from('requests')
      .update({ status: 'rejected' })
      .eq('id', requestId);

    // Notify the requester
    const { data: request } = await supabaseAdmin
      .from('requests')
      .select('creator_id, organization_id, title, metadata')
      .eq('id', requestId)
      .single();

    if (request) {
      const { data: rejecter } = await supabaseAdmin
        .from('app_users')
        .select('display_name, job_title, role')
        .eq('id', rejecterId)
        .single();

      const rejecterName = rejecter?.display_name || 'an approver';
      const rejecterRole = rejecter?.job_title || rejecter?.role || null;
      const rejecterLabel = rejecterRole ? `${rejecterName} (${rejecterRole})` : rejecterName;
      const requestRef = (request.metadata as any)?.referenceCode || `"${request.title}"`;
      const stepLabel = formatStepLabel(currentStep);
      const stepFrame = stepLabel
        ? ` at step ${currentStep.step_index} (${stepLabel})`
        : ` at step ${currentStep.step_index}`;
      const trimmedComment = (comment || '').trim();
      const reasonSuffix = trimmedComment
        ? `\n\nReason: "${truncate(trimmedComment, 240)}"`
        : '\n\nNo reason was provided.';

      const requestType = request.metadata?.type || request.metadata?.requestType;
      await this.notifyRequester(
        requestId,
        request.creator_id,
        request.organization_id,
        `${rejecterLabel} rejected ${requestRef}${stepFrame}. The request will not proceed further.${reasonSuffix}`,
        requestType,
        { title: `Request rejected by ${rejecterName}`, senderId: rejecterId }
      );

      // CAPEX Tracker: flip status to rejected. Safe for all types — hook guards internally.
      await onCapexRejected(requestId, rejecterId);
    }

    return { success: true, message: 'Request rejected' };
  }
  
  /**
   * Submit a draft request (start the workflow)
   */
  static async submitRequest(
    requestId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    
    // Get the request
    const { data: request, error: requestError } = await supabaseAdmin
      .from('requests')
      .select('*, workflow_definition_id')
      .eq('id', requestId)
      .eq('creator_id', userId)
      .single();
    
    if (requestError || !request) {
      return { success: false, error: 'Request not found' };
    }
    
    if (request.status !== 'draft') {
      return { success: false, error: 'Only draft requests can be submitted' };
    }
    
    if (!request.workflow_definition_id) {
      return { success: false, error: 'Request has no workflow definition' };
    }
    
    // Get the workflow definition
    const workflow = await this.getWorkflowDefinition(request.workflow_definition_id);
    if (!workflow) {
      return { success: false, error: 'Workflow definition not found' };
    }
    
    // Initialize workflow steps
    const stepsResult = await this.initializeWorkflowSteps(
      requestId,
      workflow,
      request.metadata || {},
      request.organization_id,
      userId
    );
    
    if (!stepsResult.success) {
      return { success: false, error: stepsResult.error };
    }
    
    // Update request status to pending
    await supabaseAdmin
      .from('requests')
      .update({ status: 'pending' })
      .eq('id', requestId);
    
    return { success: true };
  }
  
  /**
   * Resubmit a previously REJECTED request.
   *
   * Snapshots the rejected round into `metadata.resubmissionHistory` (so the
   * request detail page can show the full submission→rejection→resubmission
   * story), versions the reference code (`<base>-R{n}`), clears the old steps
   * and rebuilds the approval chain from the workflow definition — which
   * re-notifies the approver(s) — returns the request to `pending`, records a
   * `resubmission` modification, and resets the CAPEX tracker.
   *
   * Callers persist any field edits into `metadata` BEFORE calling this, so we
   * read the freshly-saved request here.
   */
  static async resubmitRequest(
    requestId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string; newReference?: string | null; version?: number }> {

    const { data: request, error: requestError } = await supabaseAdmin
      .from('requests')
      .select('*, request_steps(*)')
      .eq('id', requestId)
      .single();

    if (requestError || !request) {
      return { success: false, error: 'Request not found' };
    }

    if (
      request.creator_id !== userId &&
      !(await assistantCanActOn(userId, (request as any).organization_id, request as any, 'can_edit'))
    ) {
      return { success: false, error: 'Only the requester can resubmit this request' };
    }

    const existingSteps = (request.request_steps as any[]) || [];
    const isRejected =
      request.status === 'rejected' || existingSteps.some((s) => s.status === 'rejected');
    if (!isRejected) {
      return { success: false, error: 'Only rejected requests can be resubmitted' };
    }

    if (!request.workflow_definition_id) {
      return { success: false, error: 'Request has no workflow definition' };
    }

    const workflow = await this.getWorkflowDefinition(request.workflow_definition_id);
    if (!workflow) {
      return { success: false, error: 'Workflow definition not found' };
    }

    const metadata: Record<string, any> = { ...(request.metadata || {}) };

    // --- Version the reference: <base>-R{n} ---------------------------------
    // Strip any existing -R suffix so the base stays stable across rounds.
    const currentRef: string | null =
      typeof metadata.referenceCode === 'string' ? metadata.referenceCode : null;
    const priorCount: number =
      typeof metadata.resubmissionCount === 'number' ? metadata.resubmissionCount : 0;
    const rejectedRoundNumber = priorCount + 1; // the round that just got rejected
    const newCount = priorCount + 1;            // this resubmission's index
    const baseRef = currentRef ? currentRef.replace(/-R\d+$/, '') : null;
    const newReference = baseRef ? `${baseRef}-R${newCount}` : currentRef;

    // --- Snapshot the rejected round into resubmissionHistory ---------------
    // Rejection details (who/comment/when) live in the `approvals` table.
    const { data: rejections } = await supabaseAdmin
      .from('approvals')
      .select('step_id, approver_id, comment, signed_at')
      .eq('request_id', requestId)
      .eq('decision', 'rejected')
      .order('signed_at', { ascending: false })
      .limit(1);
    const rejection = (rejections && rejections[0]) || null;

    const rejectedStep =
      existingSteps.find((s) => rejection && s.id === rejection.step_id) ||
      existingSteps.find((s) => s.status === 'rejected') ||
      null;

    let rejectedByName: string | null = null;
    let rejectedByRole: string | null = null;
    if (rejection?.approver_id) {
      const { data: approver } = await supabaseAdmin
        .from('app_users')
        .select('display_name, first_name, last_name, email, role')
        .eq('id', rejection.approver_id)
        .maybeSingle();
      if (approver) {
        rejectedByName =
          approver.display_name ||
          [approver.first_name, approver.last_name].filter(Boolean).join(' ') ||
          approver.email ||
          null;
        rejectedByRole = approver.role || null;
      }
    }

    const round = {
      version: rejectedRoundNumber,
      referenceCode: currentRef,
      rejectedByName,
      rejectedByRole,
      rejectedAtStep: rejectedStep?.step_index ?? null,
      stepLabel: (rejectedStep?.step_definition as any)?.name ?? null,
      rejectedAt: rejection?.signed_at ?? new Date().toISOString(),
      comment: rejection?.comment ?? null,
    };

    const history = Array.isArray(metadata.resubmissionHistory) ? metadata.resubmissionHistory : [];
    history.push(round);
    metadata.resubmissionHistory = history;
    metadata.resubmissionCount = newCount;
    if (newReference) metadata.referenceCode = newReference;

    const { error: metaErr } = await supabaseAdmin
      .from('requests')
      .update({ metadata, updated_at: new Date().toISOString() })
      .eq('id', requestId);
    if (metaErr) {
      console.error('Failed to persist resubmission metadata:', metaErr);
      return { success: false, error: 'Failed to save resubmission' };
    }

    // --- Rebuild the approval chain ----------------------------------------
    // Clear the old steps (cascades to any redirections) so the engine can
    // re-initialize a fresh chain and re-notify the approver(s).
    const { error: delErr } = await supabaseAdmin
      .from('request_steps')
      .delete()
      .eq('request_id', requestId);
    if (delErr) {
      console.error('Failed to clear old steps on resubmit:', delErr);
      return { success: false, error: 'Failed to reset approval steps' };
    }

    const stepsResult = await this.initializeWorkflowSteps(
      requestId,
      workflow,
      metadata,
      request.organization_id,
      userId
    );
    if (!stepsResult.success) {
      return { success: false, error: stepsResult.error };
    }

    // Return the request to the pending queue.
    await supabaseAdmin
      .from('requests')
      .update({ status: 'pending' })
      .eq('id', requestId);

    // Timeline entry (best-effort — never blocks the resubmission).
    try {
      await supabaseAdmin.from('request_modifications').insert({
        request_id: requestId,
        modified_by: userId,
        modification_type: 'resubmission',
        field_name: null,
        old_value: currentRef,
        new_value: newReference ?? null,
      });
    } catch (e) {
      console.error('Failed to record resubmission modification:', e);
    }

    // Return the CAPEX tracker row to the active pipeline (no-op otherwise).
    try {
      await onCapexResubmitted(requestId, userId);
    } catch (e) {
      console.error('onCapexResubmitted failed on resubmit:', e);
    }

    return { success: true, newReference: newReference ?? null, version: newCount };
  }

  /**
   * Withdraw a request
   */
  static async withdrawRequest(
    requestId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    
    const { data: request } = await supabaseAdmin
      .from('requests')
      .select('creator_id, status, workflow_definition_id, organization_id, metadata')
      .eq('id', requestId)
      .single();

    if (!request) {
      return { success: false, error: 'Request not found' };
    }

    if (
      request.creator_id !== userId &&
      !(await assistantCanActOn(userId, (request as any).organization_id, request as any, 'can_withdraw'))
    ) {
      return { success: false, error: 'Only the requester can withdraw' };
    }
    
    if (request.status !== 'pending' && request.status !== 'draft') {
      return { success: false, error: 'Cannot withdraw a completed request' };
    }
    
    // Check workflow settings
    if (request.workflow_definition_id) {
      const workflow = await this.getWorkflowDefinition(request.workflow_definition_id);
      if (workflow && !workflow.settings.allowWithdraw) {
        return { success: false, error: 'This workflow does not allow withdrawal' };
      }
    }
    
    await supabaseAdmin
      .from('requests')
      .update({ status: 'withdrawn' })
      .eq('id', requestId);

    return { success: true };
  }

  /**
   * Unsubmit a pending request back to an editable draft.
   *
   * Unlike `withdraw` (terminal), this pulls a request out of the approval
   * queue so the requester can amend and resubmit it — but ONLY while no
   * approver has acted yet. The steps are cleared (they're rebuilt from the
   * possibly-amended approvers when the draft is published again) and any
   * approver who was waiting on it is told it was pulled back.
   */
  static async unsubmitRequest(
    requestId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {

    const { data: request } = await supabaseAdmin
      .from('requests')
      .select('creator_id, status, organization_id, title, metadata, request_steps(status, approver_user_id, step_index)')
      .eq('id', requestId)
      .single();

    if (!request) {
      return { success: false, error: 'Request not found' };
    }

    if (
      request.creator_id !== userId &&
      !(await assistantCanActOn(userId, (request as any).organization_id, request as any, 'can_withdraw'))
    ) {
      return { success: false, error: 'Only the requester can unsubmit this request' };
    }

    if (request.status === 'draft') {
      return { success: false, error: 'This request is already an editable draft' };
    }

    // Pending → unsubmit (pull back to edit); Cancelled → revive (reopen).
    const isRevive = request.status === 'cancelled';
    if (request.status !== 'pending' && !isRevive) {
      return { success: false, error: 'Only pending or cancelled requests can be reopened' };
    }

    const steps = (request.request_steps as any[]) || [];
    if (isRevive) {
      // Don't reopen something that had already been fully approved before it was cancelled.
      const prevStatus = (request.metadata as any)?.cancellation?.previousStatus;
      const fullyApproved = steps.length > 0 && steps.every((s) => s.status === 'approved');
      if (prevStatus === 'approved' || fullyApproved) {
        return { success: false, error: 'This request was already approved before it was cancelled and cannot be reopened.' };
      }
    } else {
      const anyReviewed = steps.some((s) => s.status === 'approved' || s.status === 'rejected');
      if (anyReviewed) {
        return {
          success: false,
          error: 'An approver has already reviewed this request, so it can no longer be unsubmitted. Use Cancel instead.',
        };
      }
    }

    // Who was waiting on this so we can tell them it's been pulled back.
    const pendingApproverIds = Array.from(
      new Set(
        steps
          .filter((s) => (s.status === 'pending' || s.status === 'waiting') && s.approver_user_id)
          .map((s) => s.approver_user_id as string)
      )
    );

    // Clear the steps — they're rebuilt from the (possibly amended) approvers on republish.
    const { error: delError } = await supabaseAdmin
      .from('request_steps')
      .delete()
      .eq('request_id', requestId);
    if (delError) {
      console.error('Failed to clear steps on unsubmit:', delError);
      return { success: false, error: 'Failed to unsubmit request' };
    }

    const metadata: Record<string, any> = { ...(request.metadata || {}) };
    if (isRevive) {
      metadata.revivedAt = new Date().toISOString();
      delete metadata.cancellation; // reopened — no longer cancelled
    } else {
      metadata.unsubmittedAt = new Date().toISOString();
    }
    delete metadata.current_step;
    delete metadata.total_steps;

    const { error: updateError } = await supabaseAdmin
      .from('requests')
      .update({ status: 'draft', metadata, updated_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateError) {
      console.error('Failed to unsubmit request:', updateError);
      return { success: false, error: 'Failed to reopen request' };
    }

    const requestRef = (metadata as any)?.referenceCode || request.title || 'a request';
    const note = isRevive
      ? `The requester reopened ${requestRef} to amend and resubmit it.`
      : `The requester pulled back ${requestRef} to amend it. No action is needed for now — you'll be re-notified if it's resubmitted.`;

    // For CAPEX, only the FIRST approver (the currently-active step) is told
    // about an unsubmit — the downstream approvers were never notified in the
    // first place, so pinging them is just noise. Other request types keep the
    // original behaviour of notifying everyone who was still waiting.
    const isCapex =
      (request.metadata as any)?.type === 'capex' || (request.metadata as any)?.requestType === 'capex';
    let recipientIds = pendingApproverIds;
    if (isCapex) {
      const firstStep = [...steps]
        .filter((s) => s.approver_user_id)
        .sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0))[0];
      recipientIds = firstStep?.approver_user_id ? [firstStep.approver_user_id as string] : [];
    }

    for (const approverId of recipientIds) {
      try {
        await this.notifyApprover(requestId, approverId, request.organization_id, userId, note);
      } catch (e) {
        console.error('Failed to notify approver on reopen:', e);
      }
    }

    return { success: true };
  }


  /**
   * Cancel a request with a mandatory reason.
   *
   * Either the requester OR any approver on the request may cancel, at any stage
   * — including after full approval. The record is preserved: the status flips
   * to `cancelled`, a cancellation snapshot is written to metadata, the CAPEX
   * tracker (if any) is taken out of the funding pipeline, and the other party
   * is notified.
   */
  static async cancelRequest(
    requestId: string,
    userId: string,
    reason: string
  ): Promise<{ success: boolean; error?: string }> {

    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) {
      return { success: false, error: 'A cancellation reason is required' };
    }

    const { data: request, error: requestError } = await supabaseAdmin
      .from('requests')
      .select('*, request_steps(*)')
      .eq('id', requestId)
      .single();

    if (requestError || !request) {
      return { success: false, error: 'Request not found' };
    }

    if (request.status === 'cancelled') {
      return { success: false, error: 'Request is already cancelled' };
    }
    if (request.status === 'withdrawn') {
      return { success: false, error: 'Cannot cancel a withdrawn request' };
    }

    const steps = (request.request_steps as any[]) || [];
    const isCreator = request.creator_id === userId;
    const isApprover = steps.some((s) => s.approver_user_id === userId);
    if (!isCreator && !isApprover) {
      return { success: false, error: 'Only the requester or an approver on this request can cancel it' };
    }

    const previousStatus = request.status;
    const metadata: Record<string, any> = { ...(request.metadata || {}) };
    metadata.cancellation = {
      reason: trimmedReason,
      cancelledBy: userId,
      cancelledByRole: isCreator ? 'requester' : 'approver',
      cancelledAt: new Date().toISOString(),
      previousStatus,
    };

    const { error: updateError } = await supabaseAdmin
      .from('requests')
      .update({ status: 'cancelled', metadata, updated_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateError) {
      console.error('Failed to cancel request:', updateError);
      return { success: false, error: 'Failed to cancel request' };
    }

    // Take any still-active steps out of the flow so no stale "current approver"
    // lingers on the timeline / reminder queue for a cancelled request.
    try {
      await supabaseAdmin
        .from('request_steps')
        .update({ status: 'skipped' })
        .eq('request_id', requestId)
        .in('status', ['pending', 'waiting']);
    } catch (e) {
      console.error('Failed to skip steps on cancel:', e);
    }

    // Take the CAPEX tracker row out of the active pipeline (no-op otherwise).
    try {
      await onCapexCancelled(requestId, userId);
    } catch (e) {
      console.error('onCapexCancelled failed on cancel:', e);
    }

    // Notify the other party (best-effort).
    const orgId = request.organization_id;
    const requestRef = (metadata as any)?.referenceCode || request.title || 'a request';
    try {
      if (isCreator) {
        // Requester cancelled — tell any approver still expected to act.
        const pendingApprovers = Array.from(
          new Set(
            steps
              .filter((s) => (s.status === 'pending' || s.status === 'waiting') && s.approver_user_id)
              .map((s) => s.approver_user_id as string)
          )
        );
        for (const approverId of pendingApprovers) {
          await this.notifyApprover(
            requestId,
            approverId,
            orgId,
            userId,
            `The requester cancelled ${requestRef}. No further action is needed.`
          );
        }
      } else {
        // Approver cancelled — tell the requester.
        await this.notifyRequester(
          requestId,
          request.creator_id,
          orgId,
          `${requestRef} was cancelled by an approver.\n\nReason: "${trimmedReason}"`,
          undefined,
          { title: 'Request cancelled', senderId: userId }
        );
      }
    } catch (e) {
      console.error('Failed to send cancellation notifications:', e);
    }

    return { success: true };
  }

  /**
   * Notify an approver about a pending request
   */
  private static async notifyApprover(
    requestId: string,
    approverId: string,
    organizationId: string,
    senderId: string,
    message: string
  ): Promise<void> {
    try {
      await supabaseAdmin
        .from('notifications')
        .insert({
          organization_id: organizationId,
          recipient_id: approverId,
          sender_id: senderId,
          type: 'task',
          title: 'Approval Required',
          message,
          metadata: {
            request_id: requestId,
            action_label: 'Review Request',
            action_url: `/requests/${requestId}`,
          },
          is_read: false,
        });
    } catch (error) {
      console.error('Failed to notify approver:', error);
    }

    // Copy the task to the approver's notification-managing assistants.
    await fanoutToNotificationAssistants(approverId, organizationId, {
      type: 'task',
      title: 'Approval Required',
      message,
      senderId,
      metadata: {
        request_id: requestId,
        action_label: 'Review Request',
        action_url: `/requests/${requestId}`,
      },
    });

    // Mirror the in-app task by email (gated by the approver's preferences).
    // Magic link — signs the approver in from the email straight to the request.
    await sendUserNotificationEmail({
      userId: approverId,
      actorUserId: senderId,
      kind: 'approval_tasks',
      subject: 'Approval required — The Circle',
      heading: 'A request is waiting for your approval',
      bodyHtml: `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
      actionUrl: approvalLinkUrl(appBaseUrl(), approverId, requestId),
      actionLabel: 'Review & Sign',
    });
  }
  
  /**
   * Notify the requester about their request status.
   *
   * Callers should pass a `title` describing the specific event ("Step 2
   * approved — awaiting Jane Smith", "Request rejected by John Doe",
   * "Request fully approved"). The generic 'Request Update' fallback is
   * only used when the caller doesn't supply one.
   */
  private static async notifyRequester(
    requestId: string,
    requesterId: string,
    organizationId: string,
    message: string,
    requestType?: string,
    options?: {
      title?: string;
      actionLabel?: string;
      senderId?: string | null;
      /**
       * Whether to mirror this update by email. Defaults to true (gated by
       * the requester's "request updates" preference). Full-approval events
       * pass false because the richer completion email — with the signed PDF
       * attached — is sent from pushApprovedPdfToMicrosoft instead.
       */
      sendEmail?: boolean;
    }
  ): Promise<void> {
    // Determine the correct URL based on request type
    const isComplimentaryRequest = requestType === 'hotel_booking' || requestType === 'voucher_request';
    const actionUrl = isComplimentaryRequest ? `/requests/comp/${requestId}` : `/requests/${requestId}`;

    try {
      await supabaseAdmin
        .from('notifications')
        .insert({
          organization_id: organizationId,
          recipient_id: requesterId,
          // Attribute the notification to the approver who triggered it so
          // the notification panel can display "from Jane Smith" alongside
          // the message — this is what gives the requester immediate context
          // before they expand the notification.
          sender_id: options?.senderId || null,
          type: 'info',
          title: options?.title || 'Request Update',
          message,
          metadata: {
            request_id: requestId,
            action_label: options?.actionLabel || 'View Request',
            action_url: actionUrl,
          },
          is_read: false,
        });
    } catch (error) {
      console.error('Failed to notify requester:', error);
    }

    // Copy the update to the requester's notification-managing assistants.
    await fanoutToNotificationAssistants(requesterId, organizationId, {
      type: 'info',
      title: options?.title || 'Request Update',
      message,
      senderId: options?.senderId || null,
      metadata: {
        request_id: requestId,
        action_label: options?.actionLabel || 'View Request',
        action_url: actionUrl,
      },
    });

    if (options?.sendEmail !== false) {
      await sendUserNotificationEmail({
        userId: requesterId,
        actorUserId: options?.senderId,
        kind: 'request_updates',
        subject: `${options?.title || 'Request update'} — The Circle`,
        heading: options?.title || 'Request update',
        bodyHtml: `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
        actionUrl,
        actionLabel: options?.actionLabel || 'View Request',
      });
    }
  }

  /**
   * On-behalf-of principal notification, fired once on full approval.
   *
   * When a request was filed on someone's behalf (an assistant filing for an
   * executive), the assistant is the creator_id and receives every progress
   * update. The principal, however, should hear about it only once — when the
   * request is fully approved. This inserts that single notification (and a
   * matching email). No-op when the request isn't on-behalf-of anyone, or when
   * the beneficiary happens to be the filer.
   */
  private static async notifyOnBehalfPrincipalOnApproval(
    requestId: string,
    request: { creator_id: string; organization_id: string; metadata?: any },
    requestRef: string,
    requestType?: string,
    approverId?: string | null
  ): Promise<void> {
    const principalId = request.metadata?.onBehalfOf?.userId;
    if (!principalId || principalId === request.creator_id) return;

    const isComplimentaryRequest = requestType === 'hotel_booking' || requestType === 'voucher_request';
    const actionUrl = isComplimentaryRequest ? `/requests/comp/${requestId}` : `/requests/${requestId}`;
    const message = `A request filed on your behalf, ${requestRef}, has been fully approved. The approved document is available to preview and download.`;

    try {
      await supabaseAdmin
        .from('notifications')
        .insert({
          organization_id: request.organization_id,
          recipient_id: principalId,
          sender_id: approverId || null,
          type: 'info',
          title: 'Request approved on your behalf',
          message,
          metadata: {
            request_id: requestId,
            action_label: 'View Request',
            action_url: actionUrl,
          },
          is_read: false,
        });
    } catch (error) {
      console.error('Failed to notify on-behalf principal:', error);
    }

    await sendUserNotificationEmail({
      userId: principalId,
      actorUserId: approverId,
      kind: 'request_updates',
      subject: 'A request filed on your behalf was approved — The Circle',
      heading: 'Request approved on your behalf',
      bodyHtml: `<p>${escapeHtml(message)}</p>`,
      actionUrl,
      actionLabel: 'View Request',
    });
  }

  /**
   * Hook fired when a travel authorisation reaches fully-approved.
   *
   * The IPD calls for the petty cash voucher to be auto-generated from the
   * approved trip and routed straight through HOD → Accountant → Finance
   * Director. We attempt that first via `autoCreatePettyCashFromTravelAuth`;
   * if approver resolution fails or the trip has no usable budget, we fall
   * back to the legacy "would you like to process petty cash?" CTA so the
   * requester can still create one manually.
   *
   * Only fires for travel types and only when no petty cash voucher is
   * already linked.
   */
  private static async maybeNotifyPettyCashCta(
    requestId: string,
    request: { creator_id: string; organization_id: string; title: string; metadata?: any },
    requestType?: string
  ): Promise<void> {
    const isTravelAuth = requestType === 'travel_authorization' || requestType === 'international_travel_authorization';
    // Complimentary/hotel/voucher requests can attach a travel document — when
    // they do, the same auto-petty-cash flow applies (the embedded travel doc
    // is treated as the source of the trip's budget).
    const isCompWithTravel = (
        requestType === 'hotel_booking'
        || requestType === 'external_hotel_booking'
        || requestType === 'voucher_request'
    ) && request.metadata?.processTravelDocument && request.metadata?.travelDocument;

    if (!isTravelAuth && !isCompWithTravel) return;

    // Skip if a petty cash voucher is already linked to this parent.
    if (request.metadata?.linkedPettyCashId) return;

    // Try the auto-create path first.
    try {
      const result = await autoCreatePettyCashFromTravelAuth(requestId);
      if (result.success && result.pettyCashRequestId) {
        // autoCreatePettyCash already notified the requester. Done.
        return;
      }
      if (!result.skipped) {
        // Genuine error worth logging — still fall through to the manual CTA
        // so the requester isn't left without a path forward.
        console.error('Auto-create petty cash failed:', result.error);
      }
    } catch (autoError) {
      console.error('Auto-create petty cash threw:', autoError);
    }

    // Fallback CTA: invite the requester to create the voucher themselves.
    try {
      await supabaseAdmin
        .from('notifications')
        .insert({
          organization_id: request.organization_id,
          recipient_id: request.creator_id,
          type: 'task',
          title: 'Process Petty Cash?',
          message: `Your ${
              isCompWithTravel ? 'complimentary booking' : 'travel authorization'
          } "${request.title}" is fully approved. We couldn't auto-generate the petty cash voucher (likely missing approver mapping). Would you like to create it yourself?`,
          metadata: {
            request_id: requestId,
            action_label: 'Process Petty Cash',
            action_url: `/requests/new/petty-cash?linkedTo=${requestId}`,
            cta_kind: 'petty_cash_followup',
          },
          is_read: false,
        });
    } catch (error) {
      console.error('Failed to send petty cash CTA notification:', error);
    }
  }

  /**
   * Hook fired when a Price Variation request reaches fully-approved.
   *
   * A price variation is raised against an already-approved CAPEX (see
   * pages/requests/new/price-variation.tsx). Once fully signed off we stamp the
   * parent CAPEX's metadata with a `priceVariations` entry — so anyone opening
   * the CAPEX can see a pricing variation exists — and notify the CAPEX
   * creator, its approvers and its watchers.
   *
   * No-op for any other request type. Fully guarded; a failure here must never
   * affect the approval outcome.
   */
  private static async linkPriceVariationToParent(
    variationRequestId: string,
    request: { creator_id: string; organization_id: string; title: string; metadata?: any },
    approverId: string
  ): Promise<void> {
    const type = request.metadata?.type || request.metadata?.requestType;
    if (type !== 'price-variation') return;

    const parentId = request.metadata?.parentRequestId;
    if (!parentId) return;

    try {
      const { data: parent } = await supabaseAdmin
        .from('requests')
        .select('id, creator_id, organization_id, title, metadata, request_steps(approver_user_id)')
        .eq('id', parentId)
        .single();
      if (!parent) return;

      const existing = Array.isArray(parent.metadata?.priceVariations) ? parent.metadata.priceVariations : [];
      // Idempotent: don't double-record if the hook runs twice.
      if (existing.some((v: any) => v.id === variationRequestId)) return;

      const updatedVariations = [
        ...existing,
        {
          id: variationRequestId,
          amount: request.metadata?.amount ?? null,
          variance: request.metadata?.variance ?? null,
          supplierName: request.metadata?.supplierName ?? null,
          approvedAt: new Date().toISOString(),
        },
      ];

      await supabaseAdmin
        .from('requests')
        .update({ metadata: { ...parent.metadata, priceVariations: updatedVariations } })
        .eq('id', parentId);

      // Notify everyone attached to the parent CAPEX: creator, approvers, watchers.
      const recipientIds = new Set<string>();
      if (parent.creator_id) recipientIds.add(parent.creator_id);
      for (const step of (parent.request_steps as any[] | undefined) || []) {
        if (step.approver_user_id) recipientIds.add(step.approver_user_id);
      }
      const watchers = Array.isArray(parent.metadata?.watchers) ? parent.metadata.watchers : [];
      for (const w of watchers) {
        const id = typeof w === 'string' ? w : w?.id;
        if (id) recipientIds.add(id);
      }

      const message = `A price variation has been approved for "${parent.title}". Open the CAPEX request to review the pricing variation.`;
      for (const recipientId of recipientIds) {
        try {
          await supabaseAdmin.from('notifications').insert({
            organization_id: parent.organization_id,
            recipient_id: recipientId,
            sender_id: approverId || null,
            type: 'info',
            title: 'Price variation recorded',
            message,
            metadata: {
              request_id: parentId,
              action_label: 'View CAPEX',
              action_url: `/requests/${parentId}`,
              variation_request_id: variationRequestId,
            },
            is_read: false,
          });
        } catch (err) {
          console.error('Failed to notify recipient about price variation:', err);
        }
      }
    } catch (error) {
      console.error('linkPriceVariationToParent failed:', error);
    }
  }

  /**
   * Push the freshly-generated approved PDF across Microsoft 365 — Teams
   * channel + SharePoint (organisation), the requester's OneDrive, and an
   * Outlook email to the requester with the PDF attached. Best-effort and
   * fully guarded — a failure here must never affect the approval outcome.
   * No-ops unless the GRAPH_* targets are set. The full-approval milestone
   * and the sync result are both sealed into the immutable audit log.
   */
  private static async pushApprovedPdfToMicrosoft(
    requestId: string,
    request: { title?: string; metadata?: any; creator_id?: string; organization_id?: string },
    archiveResult?: { success: boolean; archive?: any }
  ): Promise<void> {
    // Record the full-approval milestone regardless of Microsoft config.
    await recordAuditEvent({
      organizationId: request.organization_id || null,
      category: 'workflow',
      action: 'request.fully_approved',
      severity: 'notice',
      targetType: 'request',
      targetId: requestId,
      targetLabel: request.title || null,
      requestId,
      details: {
        referenceCode: request.metadata?.referenceCode || null,
        archived: !!archiveResult?.success,
      },
    });

    try {
      const storagePath = archiveResult?.archive?.storage_path;
      if (!archiveResult?.success || !storagePath) return;

      // Resolve the requester's email for the OneDrive copy + Outlook mail,
      // and their preferences for the per-user opt-outs.
      let recipientEmail: string | null = null;
      if (request.creator_id) {
        const { data: creator } = await supabaseAdmin
          .from('app_users')
          .select('email')
          .eq('id', request.creator_id)
          .single();
        recipientEmail = creator?.email || null;
      }
      const prefs = request.creator_id
        ? await getUserPreferences(request.creator_id)
        : null;

      const referenceCode = request.metadata?.referenceCode || null;
      const requestUrl = `${appBaseUrl()}/requests/${requestId}`;

      const res = await syncApprovedPdfToMicrosoft({
        storagePath,
        referenceCode,
        title: request.title || null,
        recipientEmail,
        requestUrl,
        options: {
          includeOneDrive: prefs?.autoArchiveOneDrive !== false,
          includeEmail: prefs?.emailCompletionPdf !== false,
          oneDriveFolder: prefs?.oneDriveFolder || null,
        },
      });

      // Remember where the document landed so the request page and archive
      // view can offer "Open in OneDrive / SharePoint" links.
      if (archiveResult?.archive?.id && (res.links.onedrive || res.links.sharepoint || res.links.teams)) {
        const { error: linkError } = await supabaseAdmin
          .from('archived_documents')
          .update({
            microsoft_links: res.links,
            microsoft_synced_at: new Date().toISOString(),
          })
          .eq('id', archiveResult.archive.id);
        if (linkError) console.error('Failed to persist Microsoft links on archive:', linkError);
      }

      // Completion email fallback: when Graph mail didn't send it (Graph not
      // configured, or the send failed), deliver a link-only completion email
      // through the shared transport (Graph → Resend) so the requester still
      // hears about the outcome. Preference-gated inside.
      if (!res.email && request.creator_id && prefs?.emailCompletionPdf !== false) {
        const linkRows = [
          res.links.onedrive && `<li><a href="${res.links.onedrive}">Open in your OneDrive</a></li>`,
          res.links.sharepoint && `<li><a href="${res.links.sharepoint}">Open in SharePoint</a></li>`,
        ].filter(Boolean).join('');
        await sendUserNotificationEmail({
          userId: request.creator_id,
          email: recipientEmail,
          kind: 'completion',
          subject: `Approved: ${request.title || 'Your request'}${referenceCode ? ` (${referenceCode})` : ''}`,
          heading: 'Request fully approved',
          bodyHtml: `
            <p><strong>${escapeHtml(request.title || 'Your request')}</strong>${referenceCode ? ` (${escapeHtml(referenceCode)})` : ''}
            has completed its review. The signed approval document is ready to download from the request page.</p>
            ${linkRows ? `<p>It has also been saved to your Microsoft 365:</p><ul>${linkRows}</ul>` : ''}`,
          actionUrl: `/requests/${requestId}`,
          actionLabel: 'View & download the approved PDF',
        });
      }

      if (res.teams || res.sharepoint || res.onedrive || res.email) {
        console.log(`Approved PDF synced for ${requestId} → teams:${res.teams} sharepoint:${res.sharepoint} onedrive:${res.onedrive} email:${res.email}`);
        await recordAuditEvent({
          organizationId: request.organization_id || null,
          category: 'system',
          action: 'microsoft.document_synced',
          targetType: 'request',
          targetId: requestId,
          targetLabel: request.title || null,
          requestId,
          details: { ...res, recipientEmail },
        });
      }
    } catch (e) {
      console.error('pushApprovedPdfToMicrosoft failed (non-fatal):', e);
    }
  }
}

/**
 * Render a short human label for a step, drawn from its workflow definition
 * (e.g. "Department Head", "Finance Director"). Returns an empty string when
 * the step has no useful name so callers can omit the parenthetical.
 */
function formatStepLabel(step: any): string {
  if (!step) return '';
  const def = step.step_definition as WorkflowStepDefinition | undefined;
  const name = def?.name?.trim();
  if (name) return name;
  if (step.approver_role) return String(step.approver_role).replace(/_/g, ' ');
  return '';
}

/** Trim user-supplied text to a notification-friendly length, with an ellipsis. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export default ApprovalEngine;
