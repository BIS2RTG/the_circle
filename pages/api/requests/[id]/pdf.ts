import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';
import * as fs from 'fs';
import * as path from 'path';
import { formatDateTime } from '../../../../lib/formatDate';
import { CAPEX_APPROVAL_SECTIONS } from '../../../../lib/capexApproval';
import { buildCapexPdf, CapexPdfData, CapexAttachment } from '../../../../lib/capexPdf';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from '../../../../lib/rbac';

const CAPEX_PAYBACK_LABELS: Record<string, string> = {
  '<6m': 'Less than 6 months',
  '6-12m': '6 to 12 months',
  '1-2y': '1 to 2 years',
  '2-3y': '2 to 3 years',
  '>3y': 'More than 3 years',
};

/** Resolved CAPEX signature block: every standard role, filled or blank. */
interface CapexApprovalCell {
  label: string;
  description: string;
  name: string | null;
  signedAt: string | null;
  status: string | null;
}
interface CapexApprovalData {
  sections: { title: string; cells: CapexApprovalCell[] }[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    const userId = user.id;
    
    // Fetch the request with all related data
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
        creator:app_users!requests_creator_id_fkey (
          id,
          display_name,
          email,
          department_id,
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
          approver:app_users!request_steps_approver_user_id_fkey (
            id,
            display_name,
            email
          ),
          approvals (
            id,
            decision,
            comment,
            signed_at,
            approver:app_users!approvals_approver_id_fkey (
              id,
              display_name,
              email
            )
          )
        )
      `)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Request not found' });
      }
      throw error;
    }

    // SEQUENTIAL APPROVAL VISIBILITY CHECK
    const isCreator = request.creator_id === userId;
    
    const watcherIds = request.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
      typeof w === 'string' ? w === userId : w?.id === userId
    );
    
    const userStep = request.request_steps?.find(
      (step: any) => step.approver_user_id === userId
    );
    const canApproverView = userStep && userStep.status !== 'waiting';
    
    // Super admins / requests.view_all holders can download ANY request's PDF.
    const rbacForView = (!isCreator && !isWatcher && !canApproverView)
      ? await getUserRBACProfile(userId)
      : null;
    const canViewAll = !!rbacForView && (rbacForView.is_super_admin || hasPermission(rbacForView, PERMISSIONS.REQUESTS_VIEW_ALL));

    if (!isCreator && !isWatcher && !canApproverView && !canViewAll) {
      if (userStep && userStep.status === 'waiting') {
        return res.status(403).json({
          error: 'This request is not yet ready for your review.',
          code: 'APPROVAL_NOT_YOUR_TURN'
        });
      }
      return res.status(403).json({ error: 'You do not have permission to view this request' });
    }

    // Sort request_steps by step_index
    if (request.request_steps) {
      request.request_steps.sort((a: any, b: any) => a.step_index - b.step_index);
    }

    // CAPEX renders as a true PDF that mirrors the official RTG form and appends
    // the uploaded quotation files as real pages. Everything else keeps the
    // lightweight print-to-PDF HTML.
    const isCapex =
      request.metadata?.type === 'capex' || request.metadata?.requestType === 'capex';

    if (isCapex) {
      const pdfBytes = await buildCapexPdfForRequest(request, id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="CAPEX-${request.id.substring(0, 8).toUpperCase()}.pdf"`);
      return res.status(200).send(Buffer.from(pdfBytes));
    }

    // Generate HTML for non-CAPEX requests (print-to-PDF in the browser).
    const html = generatePdfHtml(request, null);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="request-${id}.html"`);
    return res.status(200).send(html);
  } catch (error: any) {
    console.error('PDF generation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate PDF' });
  }
}

// Build the official CAPEX PDF: map the request's metadata + resolved approver
// names into the form layout, then append every uploaded document as real pages.
async function buildCapexPdfForRequest(request: any, requestId: string): Promise<Uint8Array> {
  const md = request.metadata || {};
  const roleMap: Record<string, any> = md.approverRoles || {};

  // Resolve approver display names: from request_steps where present, else app_users.
  const nameById = new Map<string, string>();
  for (const step of (request.request_steps || []) as any[]) {
    if (!step.approver_user_id) continue;
    const approver = Array.isArray(step.approver) ? step.approver[0] : step.approver;
    if (approver?.display_name) nameById.set(step.approver_user_id, approver.display_name);
  }
  const assignedIds = Object.values(roleMap).filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
  const missingIds = assignedIds.filter((uid) => !nameById.has(uid));
  if (missingIds.length > 0) {
    const { data: extraUsers } = await supabaseAdmin
      .from('app_users')
      .select('id, display_name')
      .in('id', missingIds);
    for (const u of extraUsers || []) nameById.set(u.id, u.display_name);
  }
  const nameFor = (key: string) => {
    const uid = roleMap[key];
    return uid ? nameById.get(uid) || '' : '';
  };

  // Quotations (supplier + amount), preferred supplier + reason.
  const quotes: any[] = Array.isArray(md.quotations) ? md.quotations : [];
  const quotations = quotes.map((q) => ({
    supplier: q.supplierName || '',
    amount: q.amount || '',
  }));
  const preferred = quotes.find((q) => q.isSelectedSupplier);

  // Money helpers.
  const parseNum = (s: any) => parseFloat(String(s ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const fmtMoney = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isBudgeted = md.budgetType === 'budget';
  const balance = isBudgeted ? fmtMoney(parseNum(md.budgetAmount) - parseNum(md.amountSpent)) : '';

  const budgetTypeMap: Record<string, string> = {
    budget: 'BUDGETED',
    'non-budget': 'NON-BUDGETED',
    emergency: 'EMERGENCY',
  };
  const budgetTypeDisplay = budgetTypeMap[md.budgetType] || (md.budgetType ? String(md.budgetType).toUpperCase() : '');
  const payback = md.paybackPeriod ? CAPEX_PAYBACK_LABELS[md.paybackPeriod] || md.paybackPeriod : '';

  const creator = Array.isArray(request.creator) ? request.creator[0] : request.creator;

  const data: CapexPdfData = {
    unit: md.unit || '',
    department: md.department || '',
    projectName: md.projectName || request.title || '',
    budgetType: budgetTypeDisplay,
    currency: md.currency || 'USD',
    budgetAmount: md.budgetAmount || '',
    amountSpent: md.amountSpent || '',
    balance,
    projectCost: md.amount || '',
    balanceAfter: isBudgeted ? md.budgetBalance || '' : '',
    justification: md.justification || '',
    payback,
    npv: md.npv || '',
    irr: md.irr || '',
    evaluation: md.evaluation || '',
    quotations,
    preferredSupplier: preferred?.supplierName || '',
    reason: preferred?.selectionReason || md.quotationJustification || '',
    fundingSource: md.fundingSource || '',
    requestedBy: md.requester || creator?.display_name || md.department || '',
    requestedByApprovers: CAPEX_APPROVAL_SECTIONS[0].roles.map((r) => ({ label: r.label, name: nameFor(r.key) })),
    approvedByApprovers: CAPEX_APPROVAL_SECTIONS[1].roles.map((r) => ({ label: r.label, name: nameFor(r.key) })),
    logo: (() => {
      try {
        const bytes = fs.readFileSync(path.join(process.cwd(), 'public/images/RTG_LOGO.png'));
        return { bytes: new Uint8Array(bytes), type: 'png' as const };
      } catch {
        return null;
      }
    })(),
  };

  // Append every uploaded document (quotations + supporting files) as real pages.
  const attachments: CapexAttachment[] = [];
  const { data: docs } = await supabaseAdmin
    .from('documents')
    .select('filename, storage_path, mime_type, created_at')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  for (const d of docs || []) {
    try {
      const { data: blob } = await supabaseAdmin.storage.from('quotations').download(d.storage_path);
      if (!blob) continue;
      const buf = Buffer.from(await blob.arrayBuffer());
      attachments.push({ name: d.filename || 'attachment', mime: d.mime_type || '', bytes: new Uint8Array(buf) });
    } catch (e) {
      console.error('CAPEX PDF: failed to load attachment', d.storage_path, e);
    }
  }

  return buildCapexPdf(data, attachments);
}

function generatePdfHtml(request: any, capexApproval: CapexApprovalData | null = null): string {
  const statusLabels: Record<string, string> = {
    pending: 'Pending',
    in_review: 'In Review',
    approved: 'Approved',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    draft: 'Draft',
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const formatFieldValue = (key: string, value: any): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getFieldLabel = (key: string): string => {
    const labels: Record<string, string> = {
      irr: 'Internal Rate of Return (IRR)',
      npv: 'Net Present Value (NPV)',
      unit: 'Business Unit',
      amount: 'Amount',
      endDate: 'End Date',
      category: 'Category',
      currency: 'Currency',
      requester: 'Requester',
      startDate: 'Start Date',
      budgetType: 'Budget Type',
      department: 'Department',
      description: 'Description',
      projectName: 'Project Name',
      fundingSource: 'Funding Source',
      justification: 'Justification',
      paybackPeriod: 'Payback Period',
      type: 'Request Type',
      priority: 'Priority',
    };
    return labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, str => str.toUpperCase());
  };

  // Get form data from metadata
  const getFormData = (metadata: any): Record<string, any> => {
    if (!metadata) return {};
    const formTypes = ['capex', 'leave', 'travel', 'expense', 'approval'];
    for (const formType of formTypes) {
      if (metadata[formType] && typeof metadata[formType] === 'object') {
        return metadata[formType];
      }
    }
    return metadata;
  };

  const formData = getFormData(request.metadata);
  const excludedFields = ['approvers', 'documents', 'type', 'category'];

  // Build metadata fields HTML
  let metadataHtml = '';
  Object.entries(formData).forEach(([key, value]) => {
    if (!excludedFields.includes(key) && value !== null && value !== undefined && typeof value !== 'object') {
      metadataHtml += `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 500; color: #6b7280; width: 200px;">${getFieldLabel(key)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color: #111827;">${formatFieldValue(key, value)}</td>
        </tr>
      `;
    }
  });

  // Build approval steps HTML
  let stepsHtml = '';
  if (request.request_steps && request.request_steps.length > 0) {
    request.request_steps.forEach((step: any, index: number) => {
      const stepStatus = step.status === 'approved' ? '✓ Approved' : 
                        step.status === 'rejected' ? '✗ Rejected' : 
                        '○ Pending';
      const statusColor = step.status === 'approved' ? '#059669' : 
                         step.status === 'rejected' ? '#dc2626' : 
                         '#6b7280';
      const approval = step.approvals?.[0];
      
      stepsHtml += `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center; font-weight: 600;">${index + 1}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${step.approver_role || `Step ${index + 1}`}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${step.approver?.display_name || '—'}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: ${statusColor}; font-weight: 500;">${stepStatus}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${approval?.signed_at ? formatDate(approval.signed_at) : '—'}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-style: italic; color: #6b7280;">${approval?.comment || '—'}</td>
        </tr>
      `;
    });
  }

  // CAPEX signature block — the fixed standard workflow, grouped into
  // "Project Requested By" / "Project Approved By". Every role prints, and roles
  // left blank show an empty signature line so the omission is visible.
  const esc = (s: any) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let capexApprovalHtml = '';
  if (capexApproval) {
    capexApprovalHtml = capexApproval.sections
      .map(
        (section) => `
      <div style="margin-bottom: 24px;">
        <h3 style="font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; margin: 0 0 10px 0;">${esc(section.title)}</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f3f4f6;">
              <th style="padding: 8px 10px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 34%;">Role</th>
              <th style="padding: 8px 10px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 26%;">Name</th>
              <th style="padding: 8px 10px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 24%;">Signature</th>
              <th style="padding: 8px 10px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 16%;">Date</th>
            </tr>
          </thead>
          <tbody>
            ${section.cells
              .map((cell) => {
                const nameCell = cell.name
                  ? `<span style="color:#111827;">${esc(cell.name)}</span>`
                  : `<span style="color:#9ca3af; font-style: italic;">left blank</span>`;
                const dateCell = cell.signedAt
                  ? `<span>${esc(formatDate(cell.signedAt))}</span>`
                  : `<span style="display:inline-block; min-width: 80px; border-bottom: 1px solid #9ca3af;">&nbsp;</span>`;
                return `
              <tr>
                <td style="padding: 12px 10px; border-bottom: 1px solid #e5e7eb; font-weight: 500;">${esc(cell.label)}</td>
                <td style="padding: 12px 10px; border-bottom: 1px solid #e5e7eb;">${nameCell}</td>
                <td style="padding: 12px 10px; border-bottom: 1px solid #e5e7eb;"><span style="display:inline-block; width: 100%; min-width: 90px; border-bottom: 1px solid #9ca3af;">&nbsp;</span></td>
                <td style="padding: 12px 10px; border-bottom: 1px solid #e5e7eb;">${dateCell}</td>
              </tr>
            `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `
      )
      .join('');
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Request - ${request.title}</title>
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #111827;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #fff;
    }
    .header {
      border-bottom: 2px solid #2563eb;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .title {
      font-size: 24px;
      font-weight: 700;
      color: #111827;
      margin: 0 0 8px 0;
    }
    .ref-number {
      font-size: 14px;
      color: #6b7280;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      background: ${request.status === 'approved' ? '#d1fae5' : request.status === 'rejected' ? '#fee2e2' : '#fef3c7'};
      color: ${request.status === 'approved' ? '#059669' : request.status === 'rejected' ? '#dc2626' : '#d97706'};
    }
    .section {
      margin-bottom: 30px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e5e7eb;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 20px;
    }
    .info-item {
      padding: 12px;
      background: #f9fafb;
      border-radius: 8px;
    }
    .info-label {
      font-size: 12px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .info-value {
      font-size: 14px;
      font-weight: 500;
      color: #111827;
      margin-top: 4px;
    }
    .description {
      padding: 16px;
      background: #f9fafb;
      border-radius: 8px;
      white-space: pre-wrap;
    }
    .print-btn {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 10px 20px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 500;
    }
    .print-btn:hover {
      background: #1d4ed8;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #6b7280;
      text-align: center;
    }
  </style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">Print / Save as PDF</button>
  
  <div class="header">
    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
      <div>
        <h1 class="title">${request.title}</h1>
        <div class="ref-number">Reference: REQ-${request.id.substring(0, 8).toUpperCase()}</div>
      </div>
      <span class="status-badge">${statusLabels[request.status] || request.status}</span>
    </div>
  </div>

  <div class="section">
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">Requester</div>
        <div class="info-value">${request.creator?.display_name || 'Unknown'}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Department</div>
        <div class="info-value">${request.creator?.department?.name || 'N/A'}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Created</div>
        <div class="info-value">${formatDate(request.created_at)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Last Updated</div>
        <div class="info-value">${formatDate(request.updated_at)}</div>
      </div>
    </div>
  </div>

  ${request.description ? `
  <div class="section">
    <h2 class="section-title">Description</h2>
    <div class="description">${request.description}</div>
  </div>
  ` : ''}

  ${metadataHtml ? `
  <div class="section">
    <h2 class="section-title">Request Details</h2>
    <table>
      ${metadataHtml}
    </table>
  </div>
  ` : ''}

  ${capexApproval ? `
  <div class="section">
    <h2 class="section-title">Approval</h2>
    ${capexApprovalHtml}
  </div>
  ` : stepsHtml ? `
  <div class="section">
    <h2 class="section-title">Approval Workflow</h2>
    <table>
      <thead>
        <tr style="background: #f3f4f6;">
          <th style="padding: 12px; text-align: center; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Step</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Role</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Approver</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Status</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Date</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Comment</th>
        </tr>
      </thead>
      <tbody>
        ${stepsHtml}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="footer">
    Generated from The Circle on ${formatDateTime(new Date())}
  </div>
</body>
</html>
  `;
}
