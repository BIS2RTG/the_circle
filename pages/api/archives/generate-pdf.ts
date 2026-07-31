import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { audit } from '@/lib/auditLog';
import { resolveOnBehalfProfile } from '@/lib/onBehalf';
import {
  signatureExists,
  userSignaturePath,
  userSignatureProxyUrl,
  resolveSignatureSignedUrl,
} from '@/lib/signatureStorage';

// This API generates and stores a PDF archive for a fully approved request
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
    const { requestId, force } = req.body;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    // Generate and store the archive
    const result = await generateAndStoreArchive(requestId, organizationId, user.id, !!force);

    await audit(req, user, {
      category: 'activity',
      action: 'archive.pdf_generated',
      outcome: result.success ? 'success' : 'failure',
      targetType: 'request',
      targetId: requestId,
      requestId,
      details: result.success
        ? { filename: result.archive?.filename, forced: !!force }
        : { error: result.error },
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(200).json({
      success: true,
      archive: result.archive
    });
  } catch (error: any) {
    console.error('Archive generation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate archive' });
  }
}

export async function generateAndStoreArchive(
  requestId: string, 
  organizationId: string,
  archivedBy?: string,
  force: boolean = false
): Promise<{ success: boolean; archive?: any; error?: string }> {
  try {
    // Check if archive already exists
    const { data: existingArchives } = await supabaseAdmin
      .from('archived_documents')
      .select('id, storage_path')
      .eq('request_id', requestId)
      .limit(1);

    if (existingArchives && existingArchives.length > 0) {
      if (!force) {
        return { success: true, archive: existingArchives[0] };
      }
      // Force regeneration: delete old archive record and storage file
      for (const old of existingArchives) {
        if (old.storage_path) {
          await supabaseAdmin.storage.from('archives').remove([old.storage_path]);
        }
        await supabaseAdmin.from('archived_documents').delete().eq('id', old.id);
      }
    }

    // Fetch the complete request data
    const { data: requestData, error: requestError } = await supabaseAdmin
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
          is_redirected,
          original_approver_id,
          redirected_by_id,
          redirected_at,
          redirect_reason,
          redirect_job_title,
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
            approver_id,
            authentication_method,
            signature_type,
            signature_url,
            signature_reference,
            approver:app_users!approvals_approver_id_fkey (
              id,
              display_name,
              email
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
      .eq('id', requestId)
      .single();

    if (requestError || !requestData) {
      console.error('Request fetch error:', requestError);
      return { success: false, error: `Request not found: ${requestError?.message || 'no data returned'}` };
    }

    // Type cast for easier access
    const request = requestData as any;

    // Verify request is fully approved
    if (request.status !== 'approved') {
      return { success: false, error: 'Request is not fully approved' };
    }

    // Sort steps by index
    if (request.request_steps) {
      request.request_steps.sort((a: any, b: any) => a.step_index - b.step_index);
    }

    // Get the latest approval timestamp
    let latestApprovalTimeValue: Date | null = null;
    request.request_steps?.forEach((step: any) => {
      step.approvals?.forEach((approval: any) => {
        const approvalDate = new Date(approval.signed_at);
        if (!latestApprovalTimeValue || approvalDate > latestApprovalTimeValue) {
          latestApprovalTimeValue = approvalDate;
        }
      });
    });
    const latestApprovalTime = latestApprovalTimeValue;

    // Extract creator info (handle both single object and array from Supabase)
    const creator = Array.isArray(request.creator) ? request.creator[0] : request.creator;
    
    // Fetch department name separately if creator has department_id
    let creatorDepartment: { name: string } | null = null;
    if (creator?.department_id) {
      const { data: deptData } = await supabaseAdmin
        .from('departments')
        .select('name')
        .eq('id', creator.department_id)
        .single();
      creatorDepartment = deptData;
    }

    // Get template info for field labels
    const templateId = request.metadata?.template_id || null;
    let templateData: any = null;
    
    if (templateId) {
      const { data: template } = await supabaseAdmin
        .from('form_templates')
        .select('name, workflow_mode, fields')
        .eq('id', templateId)
        .single();
      
      if (template) {
        templateData = template;
      }
    }

    // Resolve the signature image to embed for each approval. A signature
    // DRAWN at approval time is uploaded to a per-request path and stored on
    // the approval row (signature_url / signature_reference) — that is the
    // authoritative image and must win. Only when no drawn signature was
    // recorded do we fall back to the approver's pre-registered (saved)
    // signature image at signatures/<approverId>.png.
    for (const step of (request.request_steps || [])) {
      for (const approval of (step.approvals || [])) {
        const drawn = approval.signature_url || approval.signature_reference;
        if (typeof drawn === 'string' && drawn) {
          approval.signature_url = drawn;
          continue;
        }
        approval.signature_url = undefined;
        if (approval.approver_id) {
          if (await signatureExists(userSignaturePath(approval.approver_id))) {
            approval.signature_url = userSignatureProxyUrl(approval.approver_id);
          }
        }
      }
    }

    // Get form data for amount/currency
    const formData = getFormData(request.metadata);
    const amount = formData.amount ? parseFloat(formData.amount) : null;
    const currency = formData.currency || '$';

    // Get signed by name if this is a self-signed form (before PDF generation)
    let signedByName = null;
    if (formData.signed_by) {
      const { data: signedByUser } = await supabaseAdmin
        .from('app_users')
        .select('display_name')
        .eq('id', formData.signed_by)
        .single();
      signedByName = signedByUser?.display_name || null;
    }

    // Generate the PDF using PDFKit
    const pdfBuffer = await generatePdfBuffer(request, latestApprovalTime, formData, templateData, signedByName);
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const refNumber = `REQ-${request.id.substring(0, 8).toUpperCase()}`;
    const filename = `${refNumber}_${timestamp}.pdf`;
    const storagePath = `archives/${organizationId}/${requestId}/${filename}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from('archives')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return { success: false, error: `Failed to upload archive: ${uploadError.message}` };
    }

    // Prepare attached documents info
    const attachedDocs = (request.documents || []).map((doc: any) => ({
      id: doc.id,
      filename: doc.filename,
      storage_path: doc.storage_path,
      file_size: doc.file_size,
      mime_type: doc.mime_type,
    }));

    // Determine folder name and category from request type or template data
    let folderName = 'Approved Requests';
    let category = 'approved_requests';
    
    // Check request type for specific folder names
    const requestType = request.metadata?.type || request.metadata?.requestType;
    if (requestType === 'voucher_request' || requestType === 'hotel_booking') {
      folderName = 'Complimentary Vouchers';
      category = 'complimentary_vouchers';
    } else if (requestType === 'travel_authorization') {
      folderName = 'Travel Authorizations';
      category = 'travel_authorizations';
    } else if (requestType === 'capex') {
      folderName = 'CAPEX Requests';
      category = 'capex_requests';
    } else if (requestType === 'external_hotel_booking') {
      folderName = 'External Hotel Bookings';
      category = 'external_hotel_bookings';
    } else if (templateData) {
      folderName = templateData.name || 'Approved Requests';
      if (templateData.workflow_mode === 'self_sign') {
        category = 'self_signed_forms';
      }
    }

    // Extract visibility info: creator, approvers, and watchers
    const creatorId = request.creator_id;
    const approverIds = (request.request_steps || [])
      .map((step: any) => step.approver_user_id)
      .filter((id: string | null) => id !== null);
    const watcherIds = (request.metadata?.watchers || [])
      .map((w: any) => typeof w === 'string' ? w : w?.id)
      .filter((id: string | null | undefined) => id);

    // Create archive record with visibility info
    const { data: archive, error: dbError } = await supabaseAdmin
      .from('archived_documents')
      .insert({
        request_id: requestId,
        organization_id: request.organization_id,
        filename,
        storage_path: storagePath,
        file_size: pdfBuffer.length,
        mime_type: 'application/pdf',
        archived_by: archivedBy || null,
        request_title: request.title,
        request_reference: refNumber,
        requester_name: creator?.display_name || 'Unknown',
        requester_department: creatorDepartment?.name || null,
        total_amount: amount,
        currency,
        approval_completed_at: latestApprovalTime ? (latestApprovalTime as Date).toISOString() : new Date().toISOString(),
        approver_count: request.request_steps?.length || 0,
        attached_documents: attachedDocs,
        folder_name: folderName,
        template_id: templateId || null,
        category: category,
        creator_id: creatorId,
        approver_ids: approverIds,
        watcher_ids: watcherIds,
      })
      .select()
      .single();

    if (dbError) {
      console.error('Database insert error:', dbError);
      return { success: false, error: `Failed to create archive record: ${dbError.message}` };
    }

    return { success: true, archive };
  } catch (error: any) {
    console.error('Archive generation error:', error);
    return { success: false, error: error.message || 'Failed to generate archive' };
  }
}

function getFormData(metadata: any): Record<string, any> {
  if (!metadata) return {};
  const formTypes = ['capex', 'leave', 'travel', 'expense', 'approval', 'comp'];
  for (const formType of formTypes) {
    if (metadata[formType] && typeof metadata[formType] === 'object') {
      return metadata[formType];
    }
  }
  return metadata;
}

function getFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    irr: 'Internal Rate of Return (IRR)',
    npv: 'Net Present Value (NPV)',
    unit: 'Business Unit',
    amount: 'Project Cost',
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
    justification: 'Business Justification',
    paybackPeriod: 'Payback Period',
    type: 'Request Type',
    priority: 'Priority / Urgency',
    evaluation: 'Evaluation',
    dateOfIntendedTravel: 'Date of Intended Travel',
    purposeOfTravel: 'Purpose of Travel',
    accompanyingAssociates: 'Accompanying Associates',
    travelMode: 'Travel Mode',
    acceptConditions: 'Conditions Accepted',
    grandTotal: 'Grand Total',
    guestNames: 'Guest Name(s)',
    isExternalGuest: 'External Guest',
    allocationType: 'Allocation Type',
    percentageDiscount: 'Percentage Discount',
    reason: 'Reason',
    processTravelDocument: 'Process Travel Document',
    hotelUnit: 'Hotel Unit',
    telBookingMade: 'Tel/Booking Already Made',
    arrivalDate: 'Arrival Date',
    departureDate: 'Departure Date',
    numberOfNights: 'Number of Nights',
    numberOfRooms: 'Number of Rooms',
    accommodationType: 'Accommodation Type',
    specialArrangements: 'Special Arrangements',
  };
  return labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, str => str.toUpperCase());
}

function formatDate(dateString: string): string {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(dateString: string): string {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

// ── PDF helper: draw a section heading ──
function drawSectionHeading(doc: any, text: string, yPos: number, pageWidth: number): number {
  if (yPos > 720) { doc.addPage(); yPos = 50; }
  doc.fontSize(11).fillColor('#374151').font('Helvetica-Bold').text(text.toUpperCase(), 50, yPos, { width: pageWidth });
  doc.font('Helvetica');
  yPos += 16;
  doc.moveTo(50, yPos).lineTo(50 + pageWidth, yPos).strokeColor('#d1d5db').lineWidth(0.5).stroke();
  yPos += 8;
  return yPos;
}

// ── PDF helper: draw a key-value row ──
function drawFieldRow(doc: any, label: string, value: string, yPos: number, pageWidth: number, labelWidth: number = 170): number {
  if (yPos > 750) { doc.addPage(); yPos = 50; }
  doc.rect(50, yPos, labelWidth, 22).fillColor('#f3f4f6').fill();
  doc.fontSize(8).fillColor('#6b7280').font('Helvetica-Bold').text(label.toUpperCase(), 55, yPos + 7, { width: labelWidth - 10 });
  doc.font('Helvetica').fontSize(9).fillColor('#111827').text(value || 'N/A', 50 + labelWidth + 8, yPos + 7, { width: pageWidth - labelWidth - 8 });
  return yPos + 25;
}

// ── PDF helper: draw a table ──
function drawTable(doc: any, headers: string[], rows: string[][], yPos: number, pageWidth: number, colWidths?: number[]): number {
  const numCols = headers.length;
  const defaultColWidth = pageWidth / numCols;
  const widths = colWidths || headers.map(() => defaultColWidth);
  const rowHeight = 20;

  // Header row
  if (yPos > 720) { doc.addPage(); yPos = 50; }
  let xPos = 50;
  headers.forEach((header, i) => {
    doc.rect(xPos, yPos, widths[i], rowHeight).fillColor('#e5e7eb').fill();
    doc.rect(xPos, yPos, widths[i], rowHeight).strokeColor('#d1d5db').lineWidth(0.5).stroke();
    doc.fontSize(7).fillColor('#374151').font('Helvetica-Bold').text(header.toUpperCase(), xPos + 4, yPos + 6, { width: widths[i] - 8 });
    xPos += widths[i];
  });
  doc.font('Helvetica');
  yPos += rowHeight;

  // Data rows
  rows.forEach((row) => {
    if (yPos > 750) { doc.addPage(); yPos = 50; }
    xPos = 50;
    row.forEach((cell, i) => {
      doc.rect(xPos, yPos, widths[i], rowHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.fontSize(8).fillColor('#111827').text(cell || '', xPos + 4, yPos + 6, { width: widths[i] - 8 });
      xPos += widths[i];
    });
    yPos += rowHeight;
  });

  return yPos + 5;
}

// ── PDF helper: draw a checkbox field ──
function drawCheckboxField(doc: any, label: string, checked: boolean, yPos: number, pageWidth: number): number {
  if (yPos > 750) { doc.addPage(); yPos = 50; }
  const boxSize = 10;
  doc.rect(55, yPos, boxSize, boxSize).strokeColor('#6b7280').lineWidth(1).stroke();
  if (checked) {
    doc.fontSize(9).fillColor('#22c55e').text('✓', 56.5, yPos + 0.5);
  }
  doc.fontSize(9).fillColor('#111827').text(label, 70, yPos + 1, { width: pageWidth - 30 });
  return yPos + 18;
}

// ════════════════════════════════════════════════════════════════════════
// Official-form layout helpers (Travel & CAPEX) — mirror the printed RTG forms
// ════════════════════════════════════════════════════════════════════════
// Professional black/white/grey palette matching the printed RTG forms — no
// colour accents, just ink on paper with light-grey shading and borders.
const OFORM = { ink: '#111827', mute: '#4b5563', line: '#9ca3af', shade: '#f3f4f6', tableHead: '#e5e7eb', tableHeadInk: '#111827', rule: '#6b7280' };

function humanizeRole(s: string): string {
  if (!s) return '';
  if (/[a-z]/.test(s) && /\s/.test(s)) return s; // already a human label
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Human labels for the workflow role keys stored in metadata.approverRoles.
// Used so signed approval blocks show the role (position) the person filled —
// exactly as the form's approval section does — instead of "Approver N".
const ROLE_LABELS: Record<string, string> = {
  line_manager: 'Line Manager',
  functional_head: 'Functional Head',
  hrd: 'Chief Human Capital Officer',
  ceo: 'CEO',
  finance_manager: 'Finance Manager',
  general_manager: 'General Manager',
  procurement_manager: 'Procurement Manager',
  finance_director: 'Finance Director',
  managing_director: 'Managing Director',
  corporate_hod: 'Corporate HOD',
};

/** Light-grey section bar with dark label. */
function oHeading(doc: any, text: string, y: number, pw: number): number {
  if (y > 730) { doc.addPage(); y = 50; }
  doc.rect(50, y, pw, 18).fillColor(OFORM.tableHead).fill();
  doc.rect(50, y, pw, 18).strokeColor(OFORM.line).lineWidth(0.5).stroke();
  doc.fontSize(9).fillColor(OFORM.tableHeadInk).font('Helvetica-Bold').text(text.toUpperCase(), 56, y + 5, { width: pw - 12 });
  doc.font('Helvetica');
  return y + 26;
}

/** Row of bordered label/value cells. */
function oInfoRow(doc: any, cells: Array<{ label: string; value: string }>, y: number, pw: number, h = 30): number {
  if (y + h > 780) { doc.addPage(); y = 50; }
  const colW = pw / cells.length;
  cells.forEach((c, i) => {
    const x = 50 + i * colW;
    doc.rect(x, y, colW, h).strokeColor(OFORM.line).lineWidth(0.7).stroke();
    doc.rect(x + 0.5, y + 0.5, colW - 1, 13).fillColor(OFORM.shade).fill();
    doc.fontSize(6.5).fillColor(OFORM.mute).font('Helvetica-Bold').text((c.label || '').toUpperCase(), x + 5, y + 3.5, { width: colW - 10 });
    doc.font('Helvetica').fontSize(9).fillColor(OFORM.ink).text(c.value || 'N/A', x + 5, y + 17, { width: colW - 10 });
  });
  return y + h;
}

/** Full-width label/value cell. */
function oFullRow(doc: any, label: string, value: string, y: number, pw: number, h = 30): number {
  if (y + h > 780) { doc.addPage(); y = 50; }
  doc.rect(50, y, pw, h).strokeColor(OFORM.line).lineWidth(0.7).stroke();
  doc.rect(50.5, y + 0.5, pw - 1, 13).fillColor(OFORM.shade).fill();
  doc.fontSize(6.5).fillColor(OFORM.mute).font('Helvetica-Bold').text((label || '').toUpperCase(), 55, y + 3.5, { width: pw - 10 });
  doc.font('Helvetica').fontSize(9).fillColor(OFORM.ink).text(value || 'N/A', 55, y + 17, { width: pw - 10 });
  return y + h;
}

/** Bordered table with a shaded header. */
function oTable(doc: any, headers: string[], rows: string[][], widthsPct: number[], y: number, pw: number): number {
  const widths = widthsPct.map((p) => pw * p);
  const rh = 18;
  if (y + rh > 780) { doc.addPage(); y = 50; }
  let x = 50;
  headers.forEach((hd, i) => {
    doc.rect(x, y, widths[i], rh).fillColor(OFORM.tableHead).fill();
    doc.rect(x, y, widths[i], rh).strokeColor(OFORM.line).lineWidth(0.7).stroke();
    doc.fontSize(7).fillColor(OFORM.tableHeadInk).font('Helvetica-Bold').text(hd.toUpperCase(), x + 4, y + 5.5, { width: widths[i] - 8 });
    x += widths[i];
  });
  doc.font('Helvetica');
  y += rh;
  rows.forEach((r) => {
    if (y + rh > 790) { doc.addPage(); y = 50; }
    x = 50;
    r.forEach((cell, i) => {
      doc.rect(x, y, widths[i], rh).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.fontSize(8).fillColor(OFORM.ink).text(String(cell ?? ''), x + 4, y + 5, { width: widths[i] - 8 });
      x += widths[i];
    });
    y += rh;
  });
  return y;
}

/** Emphasised total row. */
function oTotalRow(doc: any, label: string, value: string, y: number, pw: number): number {
  if (y + 20 > 790) { doc.addPage(); y = 50; }
  doc.rect(50, y, pw, 20).fillColor(OFORM.tableHead).fill();
  doc.rect(50, y, pw, 20).strokeColor(OFORM.line).lineWidth(0.7).stroke();
  doc.fontSize(9).fillColor(OFORM.ink).font('Helvetica-Bold').text(label.toUpperCase(), 55, y + 6, { width: pw * 0.6 });
  doc.text(value, 55, y + 6, { width: pw - 10, align: 'right' });
  doc.font('Helvetica');
  return y + 20;
}

/** Allocation-to-unit tick boxes, 5 per row. */
function oTickBoxes(doc: any, items: Array<{ label: string; checked?: boolean; cost?: string }>, y: number, pw: number): number {
  const perRow = 5;
  const cellW = pw / perRow;
  items.forEach((it, i) => {
    const col = i % perRow;
    if (i > 0 && col === 0) y += 20;
    if (y + 12 > 790) { doc.addPage(); y = 50; }
    const x = 50 + col * cellW;
    doc.rect(x, y, 9, 9).strokeColor(OFORM.mute).lineWidth(0.8).stroke();
    if (it.checked) doc.moveTo(x + 1.5, y + 4.5).lineTo(x + 3.5, y + 7).lineTo(x + 7.5, y + 2).strokeColor(OFORM.ink).lineWidth(1.2).stroke();
    doc.fontSize(8).fillColor(OFORM.ink).font('Helvetica').text(it.label + (it.checked && it.cost ? ` (${it.cost})` : ''), x + 14, y + 0.5, { width: cellW - 18 });
  });
  return y + 22;
}

export interface OfficialApprovalSlot {
  role: string;
  name: string;
  date: string | null;
  sig: Buffer | null;
  redirected?: boolean;
}

/** Official-style approval blocks with captured signature + name + date. */
function oApprovals(doc: any, slots: OfficialApprovalSlot[], y: number, pw: number): number {
  const perRow = 2;
  const gap = 14;
  const boxW = (pw - gap) / perRow;
  const boxH = 76;
  slots.forEach((s, i) => {
    const col = i % perRow;
    if (i > 0 && col === 0) y += boxH + 10;
    if (y + boxH > 790) { doc.addPage(); y = 50; }
    const x = 50 + col * (boxW + gap);
    doc.rect(x, y, boxW, boxH).strokeColor(OFORM.line).lineWidth(0.8).stroke();
    doc.rect(x + 0.5, y + 0.5, boxW - 1, 15).fillColor(OFORM.shade).fill();
    doc.fontSize(7).fillColor(OFORM.tableHeadInk).font('Helvetica-Bold').text((s.role || '').toUpperCase(), x + 6, y + 4.5, { width: boxW - 12 });
    if (s.sig) {
      try { doc.image(s.sig, x + 8, y + 20, { fit: [boxW - 60, 30] }); } catch { /* ignore */ }
    } else {
      doc.moveTo(x + 8, y + 47).lineTo(x + boxW - 70, y + 47).strokeColor('#9ca3af').lineWidth(0.6).stroke();
    }
    doc.font('Helvetica').fontSize(8).fillColor(OFORM.ink).text(s.name || '', x + 8, y + 51, { width: boxW - 16 });
    doc.fontSize(6.5).fillColor(OFORM.mute).text(s.date ? `Signed ${formatDate(s.date)}` : 'Pending', x + 8, y + 63, { width: boxW - 16 });
  });
  return y + boxH + 8;
}

/** Grey document-control strip (doc no / department / page). */
function oDocControl(doc: any, parts: string[], y: number, pw: number): number {
  y += 4;
  if (y + 16 > 790) { doc.addPage(); y = 50; }
  doc.rect(50, y, pw, 16).fillColor('#faf8f4').fill();
  doc.rect(50, y, pw, 16).strokeColor(OFORM.line).lineWidth(0.5).stroke();
  const colW = pw / parts.length;
  parts.forEach((p, i) => {
    doc.fontSize(6.5).fillColor(OFORM.mute).font('Helvetica-Bold').text(p, 55 + i * colW, y + 5, { width: colW - 6, align: i === 0 ? 'left' : i === parts.length - 1 ? 'right' : 'center' });
  });
  doc.font('Helvetica');
  return y + 20;
}

// ── Detect form type from metadata ──
function detectFormType(metadata: any): string {
  if (!metadata) return 'generic';
  if (metadata.type === 'travel_authorization' || metadata.itinerary) return 'travel_authorization';
  if (metadata.type === 'capex' || metadata.capex || metadata.projectName) return 'capex';
  if (metadata.type === 'external_hotel_booking' || metadata.hotelBooking?.hotelUnit) return 'external_hotel_booking';
  if (metadata.type === 'hotel_booking' || metadata.selectedBusinessUnits || metadata.guestNames) return 'hotel_booking';
  return 'generic';
}

// ── Render Travel Authorization form data (official HR APX-27 layout) ──
function renderTravelAuth(
  doc: any,
  formData: Record<string, any>,
  yPos: number,
  pageWidth: number,
  creator: any,
  creatorDept: any,
  approvalSlots: OfficialApprovalSlot[] = [],
  selfSig: Buffer | null = null,
  onBehalf: boolean = false,
): number {
  const pw = pageWidth;

  // Employee / request details grid
  yPos = oInfoRow(doc, [
    { label: 'Name of Employee', value: creator?.display_name || 'N/A' },
    { label: 'Department', value: formData.department || creatorDept?.name || 'N/A' },
  ], yPos, pw);
  yPos = oInfoRow(doc, [
    { label: 'Date of Request', value: formatDate(formData.dateOfRequest || formData.createdAt) },
    { label: 'Date of Intended Travel', value: formatDate(formData.dateOfIntendedTravel) },
  ], yPos, pw);
  yPos = oFullRow(doc, 'Purpose of Travel', formData.purposeOfTravel || 'N/A', yPos, pw, 34);
  yPos = oFullRow(doc, 'Accompanying Associates', formData.accompanyingAssociates || 'None', yPos, pw);
  yPos = oFullRow(doc, 'Travel Mode (Vehicle Registration if Driving)',
    [formData.travelMode, formData.vehicleRegistration].filter(Boolean).join(' — ') || 'N/A', yPos, pw);
  yPos += 8;

  // Conditions of Travel
  yPos = oHeading(doc, 'Conditions of Travel', yPos, pw);
  const conds = [
    'Authorization must be sought using this form at least 7 days prior to departure.',
    'Travel expenses must be claimed within 30 days after completion of travel, otherwise the claim shall be void.',
    'It is an act of misconduct to travel without authority.',
  ];
  conds.forEach((c, i) => {
    if (yPos > 760) { doc.addPage(); yPos = 50; }
    const line = `${i + 1}. ${c}`;
    doc.fontSize(8).fillColor('#4b5563').text(line, 55, yPos, { width: pw - 10 });
    yPos += doc.heightOfString(line, { width: pw - 10 }) + 3;
  });
  doc.rect(55, yPos, 9, 9).strokeColor(OFORM.mute).lineWidth(0.8).stroke();
  if (formData.acceptConditions) doc.moveTo(56.5, yPos + 4.5).lineTo(58.5, yPos + 7).lineTo(62.5, yPos + 2).strokeColor(OFORM.ink).lineWidth(1.2).stroke();
  doc.fontSize(8).fillColor(OFORM.ink).font('Helvetica').text('I have read these conditions and accept them.', 70, yPos + 0.5);
  yPos += 18;

  // Signature of traveller — omitted entirely when filed on behalf of someone
  // (the principal never personally signed; the acceptance tick above is the
  // only mark). Rendered only when the traveller filed for themselves.
  if (!onBehalf) {
    doc.fontSize(6.5).fillColor(OFORM.mute).font('Helvetica-Bold').text('SIGNATURE OF TRAVELLER', 55, yPos);
    yPos += 10;
    if (selfSig) { try { doc.image(selfSig, 55, yPos, { fit: [150, 34] }); } catch { /* ignore */ } yPos += 36; }
    else { doc.moveTo(55, yPos + 16).lineTo(205, yPos + 16).strokeColor('#9ca3af').lineWidth(0.6).stroke(); yPos += 22; }
    doc.font('Helvetica');
  }
  yPos = oDocControl(doc, ['DOC NO: HR APX-27', 'DEPARTMENT: HUMAN RESOURCES', 'PAGE: 1 of 1'], yPos, pw);
  yPos += 6;

  // Travel Itinerary
  yPos = oHeading(doc, 'Travel Itinerary', yPos, pw);
  const itinRows = (Array.isArray(formData.itinerary) ? formData.itinerary : [])
    .filter((r: any) => r.date || r.from || r.to)
    .map((r: any) => [r.date ? formatDate(r.date) : '', r.from || '', r.to || '', r.km || '', r.justification || '']);
  yPos = oTable(doc, ['Date/Time', 'From', 'To', 'Km', 'Justification'],
    itinRows.length ? itinRows : [['', '', '', '', '']], [0.18, 0.2, 0.2, 0.1, 0.32], yPos, pw);
  yPos += 10;

  // Travel Budget
  if (formData.budget && typeof formData.budget === 'object') {
    yPos = oHeading(doc, 'Travel Budget', yPos, pw);
    const b = formData.budget;
    const items: Array<{ label: string; data: any }> = [
      { label: 'Fuel (Indicate total litres)', data: b.fuel },
      { label: 'AA Rates (Indicate total mileage)', data: b.aaRates },
      { label: 'Air/Bus Tickets', data: b.airBusTickets },
      { label: 'Overnight Accommodation (b&b)', data: b.bb || b['b&b'] },
      { label: 'Lunch/Dinner', data: b.lunchDinner },
      { label: 'Conferencing Cost', data: b.conferencingCost },
      { label: 'Tollgates', data: b.tollgates },
      { label: b.other?.description || 'Other (Specify)', data: b.other },
    ];
    const budgetRows = items.filter((it) => it.data).map((it) => [it.label, it.data.unitCost || '0.00', it.data.totalCost || '0.00']);
    yPos = oTable(doc, ['Expenditure Item', 'Unit Cost (USD)', 'Total Cost (USD)'],
      budgetRows.length ? budgetRows : [['', '', '']], [0.55, 0.22, 0.23], yPos, pw);
    yPos = oTotalRow(doc, 'Grand Total', `USD ${formData.grandTotal || '0.00'}`, yPos, pw);
    yPos += 10;
  }

  // Allocation Cost to Unit
  yPos = oHeading(doc, 'Allocation Cost to Unit', yPos, pw);
  const alloc = formData.costAllocation && typeof formData.costAllocation === 'object' ? formData.costAllocation : {};
  const UNITS = ['Corp', 'MRC', 'NAH', 'RTH', 'KHCC', 'BRH', 'VFRH', 'AZRL', 'HEXA', 'GWS'];
  yPos = oTickBoxes(doc, UNITS.map((u) => {
    const v = alloc[u] ?? alloc[u.toLowerCase()];
    return { label: u, checked: v != null && v !== '' && v !== 0, cost: v ? `USD ${v}` : undefined };
  }), yPos, pw);
  yPos += 8;

  // Approvals
  if (approvalSlots.length) {
    yPos = oHeading(doc, 'Approvals', yPos, pw);
    yPos = oApprovals(doc, approvalSlots, yPos, pw);
  }

  return yPos;
}

// ── Render CAPEX form data (official Capital Expenditure Form layout) ──
function renderCapex(
  doc: any,
  formData: Record<string, any>,
  yPos: number,
  pageWidth: number,
  creator: any,
  creatorDept: any,
  approvalSlots: OfficialApprovalSlot[] = [],
): number {
  const pw = pageWidth;
  const cur = formData.currency === 'ZIG' ? 'ZiG' : 'USD';
  const money = (v: any) => (v != null && v !== '' ? `${cur} ${v}` : 'N/A');

  yPos = oInfoRow(doc, [
    { label: 'Unit', value: formData.unit || 'N/A' },
    { label: 'Department', value: formData.department || creatorDept?.name || 'N/A' },
  ], yPos, pw);
  yPos = oFullRow(doc, 'Description of Project', formData.projectName || 'N/A', yPos, pw, 40);
  if (formData.description) {
    yPos = oFullRow(doc, 'Detailed Description', formData.description, yPos, pw, 40);
  }
  yPos = oInfoRow(doc, [
    { label: 'Budget / Non-Budget / Emergency', value: (formData.budgetType || 'N/A').toString().replace(/_/g, ' ') },
    { label: 'Project Requested By', value: formData.requester || creator?.display_name || 'N/A' },
  ], yPos, pw);
  yPos = oInfoRow(doc, [
    { label: 'Budget Amount', value: formData.budgetAmount ? money(formData.budgetAmount) : 'NIL' },
    { label: 'Amount Spent to Date', value: formData.amountSpent ? money(formData.amountSpent) : 'NIL' },
    { label: 'Balance', value: formData.balance ? money(formData.balance) : 'NIL' },
  ], yPos, pw);
  yPos = oInfoRow(doc, [
    { label: 'Project Cost (excl VAT)', value: money(formData.amount) },
    { label: 'Balance After This Purchase', value: formData.balanceAfter ? money(formData.balanceAfter) : 'NIL' },
  ], yPos, pw);
  yPos = oFullRow(doc, 'Justification of Project', formData.justification || 'N/A', yPos, pw, 34);
  yPos += 8;

  // Evaluation
  yPos = oHeading(doc, 'Evaluation (for profit improvement)', yPos, pw);
  yPos = oInfoRow(doc, [
    { label: 'Payback (Years)', value: formData.paybackPeriod || '-' },
    { label: 'NPV', value: formData.npv || '-' },
    { label: 'IRR', value: formData.irr || '-' },
  ], yPos, pw);
  if (formData.evaluation) yPos = oFullRow(doc, 'Evaluation Notes', formData.evaluation, yPos, pw);
  yPos += 8;

  // Quotations
  const quotes = Array.isArray(formData.quotations) ? formData.quotations : [];
  if (quotes.length) {
    yPos = oHeading(doc, 'Quotations', yPos, pw);
    const rows = quotes.map((q: any, i: number) => [
      String(i + 1),
      q.supplierName || q.supplier || '',
      q.description || '',
      q.amount ? `${cur} ${q.amount}` : '',
    ]);
    yPos = oTable(doc, ['#', 'Supplier', 'Description', 'Amount'], rows, [0.07, 0.28, 0.43, 0.22], yPos, pw);
  }
  yPos = oInfoRow(doc, [
    { label: 'Preferred Quotation', value: formData.preferredSupplier || quotes[0]?.supplierName || 'N/A' },
    { label: 'Project Funded From', value: formData.fundingSource || 'N/A' },
  ], yPos, pw);
  if (formData.quotationReason || formData.quotationJustification) {
    yPos = oFullRow(doc, 'Reason for Preferred Supplier', formData.quotationReason || formData.quotationJustification, yPos, pw);
  }
  yPos += 8;

  // Approvals
  if (approvalSlots.length) {
    yPos = oHeading(doc, 'Approvals', yPos, pw);
    yPos = oApprovals(doc, approvalSlots, yPos, pw);
  }

  return yPos;
}

// ── Render Hotel Booking form data ──
function renderHotelBooking(doc: any, formData: Record<string, any>, yPos: number, pageWidth: number, creator: any, creatorDept: any): number {
  yPos = drawSectionHeading(doc, 'Guest Information', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Guest Name(s)', formData.guestNames || 'N/A', yPos, pageWidth);
  yPos = drawCheckboxField(doc, 'External Guest', !!formData.isExternalGuest, yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Allocation Type', (formData.allocationType || '').replace(/_/g, ' '), yPos, pageWidth);
  if (formData.percentageDiscount) yPos = drawFieldRow(doc, 'Percentage Discount', `${formData.percentageDiscount}%`, yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Reason', formData.reason || 'N/A', yPos, pageWidth);
  yPos = drawCheckboxField(doc, 'Process Travel Document', !!formData.processTravelDocument, yPos, pageWidth);
  yPos += 5;

  // Selected Business Units table
  if (formData.selectedBusinessUnits && Array.isArray(formData.selectedBusinessUnits) && formData.selectedBusinessUnits.length > 0) {
    yPos = drawSectionHeading(doc, 'Hotel Reservations', yPos, pageWidth);
    const headers = ['Hotel Unit', 'Arrival', 'Departure', 'Nights', 'Rooms', 'Type'];
    const colWidths = [pageWidth * 0.25, pageWidth * 0.15, pageWidth * 0.15, pageWidth * 0.1, pageWidth * 0.1, pageWidth * 0.25];
    const rows = formData.selectedBusinessUnits.map((bu: any) => [
      bu.name || '',
      bu.arrivalDate ? formatDate(bu.arrivalDate) : '',
      bu.departureDate ? formatDate(bu.departureDate) : '',
      bu.numberOfNights || '',
      bu.numberOfRooms || '',
      (bu.accommodationType || '').replace(/_/g, ' '),
    ]);
    yPos = drawTable(doc, headers, rows, yPos, pageWidth, colWidths);
    yPos += 5;
  }

  // Travel data if processTravelDocument. The travel authorisation is persisted
  // under `travelDocument`; its cost allocation is a sibling (`travelCostAllocation`)
  // entered by the requestor — merge it in so renderTravelAuth prints it under
  // "Allocation Cost to Unit" (it reads td.costAllocation).
  if (formData.travelData || formData.travelDocument || formData.processTravelDocument) {
    const baseTd = formData.travelData || formData.travelDocument || formData;
    if (baseTd.itinerary || baseTd.budget) {
      const td = { ...baseTd, costAllocation: baseTd.costAllocation || formData.travelCostAllocation || {} };
      yPos = renderTravelAuth(doc, td, yPos, pageWidth, creator, creatorDept);
    }
  }

  return yPos;
}

// ── Render External Hotel Booking form data ──
function renderExternalHotelBooking(doc: any, formData: Record<string, any>, yPos: number, pageWidth: number): number {
  // The metadata may be nested under hotelBooking
  const data = formData.hotelBooking || formData;

  yPos = drawSectionHeading(doc, 'Hotel Reservation', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Hotel Unit', data.hotelUnit || 'N/A', yPos, pageWidth);
  yPos += 5;

  yPos = drawSectionHeading(doc, 'Guest Information', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Guest Name(s)', data.guestNames || 'N/A', yPos, pageWidth);
  yPos = drawCheckboxField(doc, 'Tel / Booking Already Made', !!data.telBookingMade, yPos, pageWidth);
  yPos += 5;

  yPos = drawSectionHeading(doc, 'Stay Details', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Arrival Date', formatDate(data.arrivalDate), yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Departure Date', formatDate(data.departureDate), yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Number of Nights', data.numberOfNights || 'N/A', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Number of Rooms', data.numberOfRooms || 'N/A', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Accommodation Type', (data.accommodationType || '').replace(/_/g, ' '), yPos, pageWidth);
  yPos += 5;

  yPos = drawSectionHeading(doc, 'Allocation & Discount', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Allocation Type', (data.allocationType || '').replace(/_/g, ' '), yPos, pageWidth);
  if (data.percentageDiscount) yPos = drawFieldRow(doc, 'Percentage Discount', `${data.percentageDiscount}%`, yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Special Arrangements', data.specialArrangements || 'N/A', yPos, pageWidth);
  yPos = drawFieldRow(doc, 'Reason', data.reason || 'N/A', yPos, pageWidth);
  yPos = drawCheckboxField(doc, 'Process Travel Document', !!data.processTravelDocument, yPos, pageWidth);
  yPos += 5;

  return yPos;
}

// ── Render generic form data (fallback for unknown form types) ──
function renderGenericForm(doc: any, formData: Record<string, any>, yPos: number, pageWidth: number, templateData: any = null): number {
  const excludedFields = ['approvers', 'documents', 'type', 'category', 'watchers', 'useParallelApprovals', 'current_step', 'approverRoles', 'template_id', 'signature_url', 'signed_at', 'signed_by'];

  yPos = drawSectionHeading(doc, 'Request Details', yPos, pageWidth);

  for (const [key, value] of Object.entries(formData)) {
    if (excludedFields.includes(key) || value === null || value === undefined || value === '') continue;

    const fieldLabel = templateData ? getFieldLabelFromTemplate(key, templateData) : getFieldLabel(key);

    if (Array.isArray(value)) {
      // Render arrays as tables if they contain objects
      const objectItems = value.filter(v => v && typeof v === 'object');
      if (objectItems.length > 0) {
        const allKeys = [...new Set(objectItems.flatMap(obj => Object.keys(obj)))];
        const headers = allKeys.map(k => templateData ? getFieldLabelFromTemplate(k, templateData) : getFieldLabel(k));
        const colWidths = allKeys.map(() => pageWidth / allKeys.length);
        const rows = objectItems.map(obj => allKeys.map(k => String(obj[k] ?? '')));
        if (yPos > 650) { doc.addPage(); yPos = 50; }
        doc.fontSize(9).fillColor('#374151').font('Helvetica-Bold').text(fieldLabel, 50, yPos);
        doc.font('Helvetica');
        yPos += 14;
        yPos = drawTable(doc, headers, rows, yPos, pageWidth, colWidths);
      } else {
        yPos = drawFieldRow(doc, fieldLabel, value.join(', '), yPos, pageWidth);
      }
    } else if (typeof value === 'object') {
      // Render nested objects as sub-section (like requestor_info)
      if (yPos > 650) { doc.addPage(); yPos = 50; }
      doc.fontSize(9).fillColor('#374151').font('Helvetica-Bold').text(fieldLabel, 50, yPos);
      doc.font('Helvetica');
      yPos += 14;
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subVal === null || subVal === undefined || subVal === '') continue;
        const subFieldLabel = templateData ? getFieldLabelFromTemplate(subKey, templateData) : getFieldLabel(subKey);
        if (typeof subVal === 'object') {
          yPos = drawFieldRow(doc, subFieldLabel, JSON.stringify(subVal), yPos, pageWidth);
        } else {
          yPos = drawFieldRow(doc, subFieldLabel, String(subVal), yPos, pageWidth);
        }
      }
      yPos += 5;
    } else if (typeof value === 'boolean') {
      yPos = drawCheckboxField(doc, fieldLabel, value, yPos, pageWidth);
    } else {
      yPos = drawFieldRow(doc, fieldLabel, String(value), yPos, pageWidth);
    }
  }

  return yPos;
}

function getFieldLabelFromTemplate(fieldId: string, templateData: any): string {
  if (!templateData?.fields) return getFieldLabel(fieldId);
  
  const field = templateData.fields.find((f: any) => f.id === fieldId);
  return field?.label || getFieldLabel(fieldId);
}

async function generatePdfBuffer(
  request: any,
  approvalCompletedAt: Date | null,
  formData: Record<string, any>,
  templateData: any = null,
  signedByName: string | null = null
): Promise<Buffer> {
  // Pre-fetch all signature images
  const signatureBuffers: Map<number, Buffer> = new Map();
  if (request.request_steps) {
    await Promise.all(
      request.request_steps.map(async (step: any, index: number) => {
        const approval = step.approvals?.[0];
        if (approval?.signature_url) {
          // Server-side PDF: resolve proxy/stored URL to a signed URL first.
          const resolved = await resolveSignatureSignedUrl(approval.signature_url);
          const buf = resolved ? await fetchImageBuffer(resolved) : null;
          if (buf) signatureBuffers.set(index, buf);
        }
      })
    );
  }

  // Pre-fetch self-sign signature if present
  let selfSignSignatureBuffer: Buffer | null = null;
  if (formData.signature_url) {
    const resolvedSelf = await resolveSignatureSignedUrl(formData.signature_url);
    selfSignSignatureBuffer = resolvedSelf ? await fetchImageBuffer(resolvedSelf) : null;
  }
  // Filed on behalf of someone? THAT person is the requestor/traveller on the
  // document — resolve their profile once and use it for the header + signature.
  const onBehalfProfile = await resolveOnBehalfProfile(request);

  // Traveller signature: official forms (travel auth) print "Signature of
  // Traveller" — the requestor's own saved signature. There's no per-request
  // drawn traveller signature, so fall back to their registered signature at
  // signatures/<travellerId>.png.
  //
  // On-behalf: the principal never personally signed (the assistant filed for
  // them), so the conditions block shows the acceptance checkbox ONLY, with no
  // signature. Skip loading any traveller signature in that case.
  if (!selfSignSignatureBuffer && !onBehalfProfile) {
    const travellerId = request.creator_id || request.creator?.id || null;
    if (travellerId && (await signatureExists(userSignaturePath(travellerId)))) {
      const resolvedTraveller = await resolveSignatureSignedUrl(userSignatureProxyUrl(travellerId));
      selfSignSignatureBuffer = resolvedTraveller ? await fetchImageBuffer(resolvedTraveller) : null;
    }
  }
  // Guard against a stray self-sign buffer (e.g. an assistant-drawn signature)
  // ever printing as the principal's traveller signature on an on-behalf form.
  const travellerSignatureBuffer = onBehalfProfile ? null : selfSignSignatureBuffer;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Approved Request - ${request.title}`,
          Author: 'The Circle - Approval Management System',
          Subject: 'Approved Request Document',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const refNumber = `REQ-${request.id.substring(0, 8).toUpperCase()}`;
      const pageWidth = doc.page.width - 100; // Account for margins
      const pageCenterX = doc.page.width / 2;

      // ── Header: Centred RTG logo (required on every PDF) ──
      // Try the several locations the file can live in across environments so
      // the logo always renders (public/ is the reliable one on Vercel).
      let logoHeight = 0;
      try {
        const logoCandidates = [
          path.join(process.cwd(), 'public', 'images', 'RTG_LOGO.png'),
          path.join(process.cwd(), 'images', 'RTG_LOGO.png'),
        ];
        const logoPath = logoCandidates.find((p) => fs.existsSync(p));
        if (logoPath) {
          const logoWidth = 160;
          const logoX = pageCenterX - logoWidth / 2;
          doc.image(logoPath, logoX, 35, { width: logoWidth });
          logoHeight = 55; // approximate height of logo at this width
        }
      } catch (e) {
        // Fallback: no logo if file not found
      }

      // Form type drives whether we render the official document layout (with
      // its own header fields + signed approval blocks) vs the generic layout.
      const formType = detectFormType(request.metadata);
      const isOfficialForm = formType === 'travel_authorization' || formType === 'capex';
      const documentTitle =
        formType === 'travel_authorization' ? 'Local Travel Authorisation'
        : formType === 'capex' ? 'Capital Expenditure Form'
        : request.title;

      // Title centred below logo
      const titleY = 35 + logoHeight + 10;
      doc.fontSize(14).fillColor('#111827').font('Helvetica-Bold').text(documentTitle, 50, titleY, {
        width: pageWidth,
        align: 'center',
      });
      doc.font('Helvetica');

      // Reference and badge
      const refY = titleY + 20;
      doc.fontSize(9).fillColor('#6b7280').text(refNumber, 50, refY, { width: pageWidth, align: 'center' });
      doc.fontSize(9).fillColor('#22c55e').text('FULLY APPROVED', 50, refY + 14, { width: pageWidth, align: 'center' });

      // Divider line
      const dividerY = refY + 30;
      doc.moveTo(50, dividerY).lineTo(545, dividerY).strokeColor('#8B4513').lineWidth(2).stroke();

      let yPos = dividerY + 12;

      let creator = Array.isArray(request.creator) ? request.creator[0] : request.creator;
      let creatorDept = creator?.department ? (Array.isArray(creator.department) ? creator.department[0] : creator.department) : null;

      // On-behalf: present the principal as the requestor throughout the
      // document (name, department, business unit) — not the assistant who
      // filed. formData.department/businessUnit were captured from the filer,
      // so override them too.
      if (onBehalfProfile) {
        creator = {
          ...creator,
          id: onBehalfProfile.id,
          display_name: onBehalfProfile.display_name,
          email: onBehalfProfile.email,
          job_title: onBehalfProfile.job_title,
          department: onBehalfProfile.department,
          business_unit: onBehalfProfile.business_unit,
        };
        creatorDept = onBehalfProfile.department || creatorDept;
        if (onBehalfProfile.department?.name) formData.department = onBehalfProfile.department.name;
        if (onBehalfProfile.business_unit?.name) formData.businessUnit = onBehalfProfile.business_unit.name;
        if (onBehalfProfile.display_name) formData.requester = onBehalfProfile.display_name;
      }

      // Generic "Request Information" grid — official forms carry their own
      // header fields (Name / Department / Date …), so skip it for those.
      if (!isOfficialForm) {
        yPos = drawSectionHeading(doc, 'Request Information', yPos, pageWidth);

        // Get department from requestor_info if available, otherwise from creator
        const departmentName = formData.requestor_info?.department || creatorDept?.name || 'N/A';

        const infoItems = [
          { label: 'Requester', value: creator?.display_name || 'Unknown' },
          { label: 'Department', value: departmentName },
          { label: 'Request Date', value: formatDate(request.created_at) },
          { label: 'Approval Completed', value: approvalCompletedAt ? formatDateTime(approvalCompletedAt.toISOString()) : formatDateTime(request.updated_at) },
        ];

        // Add template name if available
        if (templateData?.name) {
          infoItems.push({ label: 'Form Template', value: templateData.name });
        }

        // Add signed by if this is a self-signed form
        if (signedByName) {
          infoItems.push({ label: 'Signed By', value: signedByName });
        }

        const colWidth = (pageWidth - 20) / 2;
        infoItems.forEach((item, idx) => {
          if (yPos > 750) { doc.addPage(); yPos = 50; }
          const xPos = 50 + (idx % 2) * (colWidth + 20);
          if (idx > 0 && idx % 2 === 0) yPos += 35;

          doc.rect(xPos, yPos, colWidth, 30).fillColor('#f3f4f6').fill();
          doc.fontSize(7).fillColor('#6b7280').font('Helvetica-Bold').text(item.label.toUpperCase(), xPos + 8, yPos + 5);
          doc.font('Helvetica').fontSize(10).fillColor('#111827').text(item.value, xPos + 8, yPos + 16);
        });

        yPos += 45;
      }

      // Official-style approval slots (role, captured signature, name, date)
      // built from the request steps — used by the travel/capex renderers and,
      // for every other form, by the shared approval section below.
      // Map approver user id -> workflow role. Steps almost always store
      // approver_role = null (approvers were resolved by user id), so the role
      // label comes from the metadata.approverRoles (roleKey -> userId) map.
      const approverRolesMap = (request.metadata?.approverRoles || {}) as Record<string, any>;
      const roleByUserId: Record<string, string> = {};
      for (const [roleKey, uid] of Object.entries(approverRolesMap)) {
        if (uid && typeof uid === 'string') roleByUserId[uid] = roleKey;
      }
      // On complimentary booking forms the `functional_head` slot is the COO
      // (see lib/fixedApprovers) — label it accordingly on the signed document.
      // Scoped by request type so travel authorisations keep "Functional Head".
      const reqTypeForRole = (request.metadata?.type || request.metadata?.category || '') as string;
      const isCompBooking = reqTypeForRole === 'hotel_booking' || reqTypeForRole === 'external_hotel_booking';
      const approvalSlots: OfficialApprovalSlot[] = (request.request_steps || []).map((step: any, index: number) => {
        const approval = step.approvals?.[0];
        const nm = step.approver?.display_name || approval?.approver?.display_name || '';
        const roleKey = step.approver_role || roleByUserId[step.approver_user_id] || '';
        const role = (isCompBooking && roleKey === 'functional_head')
          ? 'Chief Operating Officer'
          : (ROLE_LABELS[roleKey] || humanizeRole(roleKey) || `Approver ${index + 1}`);
        return {
          role,
          name: step.is_redirected ? `pp ${nm}` : nm,
          date: approval?.signed_at || null,
          sig: signatureBuffers.get(index) || null,
          redirected: step.is_redirected === true,
        };
      });

      // ── Form-type-specific content ──
      switch (formType) {
        case 'travel_authorization':
          yPos = renderTravelAuth(doc, formData, yPos, pageWidth, creator, creatorDept, approvalSlots, travellerSignatureBuffer, !!onBehalfProfile);
          break;
        case 'capex': {
          const capexData = formData.capex || formData;
          yPos = renderCapex(doc, capexData, yPos, pageWidth, creator, creatorDept, approvalSlots);
          break;
        }
        case 'hotel_booking':
          yPos = renderHotelBooking(doc, formData, yPos, pageWidth, creator, creatorDept);
          break;
        case 'external_hotel_booking':
          yPos = renderExternalHotelBooking(doc, formData, yPos, pageWidth);
          break;
        default:
          yPos = renderGenericForm(doc, formData, yPos, pageWidth, templateData);
          break;
      }
      
      // ── Self-Sign Signature Section ──
      // Official forms render the traveller signature inline, so skip this.
      if (!isOfficialForm && formData.signature_url && formData.signed_by) {
        if (yPos > 650) {
          doc.addPage();
          yPos = 50;
        }
        
        yPos = drawSectionHeading(doc, 'Signature', yPos, pageWidth);
        
        // Display the pre-fetched signature image
        if (selfSignSignatureBuffer) {
          try {
            doc.image(selfSignSignatureBuffer, 50, yPos, { width: 200, height: 80 });
            yPos += 90;
          } catch (err) {
            console.error('Failed to embed signature image:', err);
            yPos = drawFieldRow(doc, 'Signature', 'Signature image available', yPos, pageWidth);
          }
        } else {
          yPos = drawFieldRow(doc, 'Signature', 'Signature image not available', yPos, pageWidth);
        }
        
        if (signedByName) {
          yPos = drawFieldRow(doc, 'Signed By', signedByName, yPos, pageWidth);
        }
        if (formData.signed_at) {
          yPos = drawFieldRow(doc, 'Signed At', formatDateTime(formData.signed_at), yPos, pageWidth);
        }
        yPos += 10;
      }

      // ── Approval blocks — official greyscale style for every form ──
      // Travel/capex draw their own inline; all other forms get them here so
      // every processed PDF has consistent, signed approval blocks.
      if (!isOfficialForm && approvalSlots.length > 0) {
        if (yPos > 640) { doc.addPage(); yPos = 50; }
        yPos = oHeading(doc, 'Approvals', yPos, pageWidth);
        yPos = oApprovals(doc, approvalSlots, yPos, pageWidth);

        // Approval comments, if any.
        const approvalComments = (request.request_steps || [])
          .map((step: any, idx: number) => {
            const a = step.approvals?.[0];
            return a?.comment ? { name: step.approver?.display_name || `Approver ${idx + 1}`, comment: a.comment } : null;
          })
          .filter(Boolean) as Array<{ name: string; comment: string }>;
        if (approvalComments.length > 0) {
          if (yPos > 700) { doc.addPage(); yPos = 50; }
          doc.fontSize(11).fillColor(OFORM.ink).font('Helvetica-Bold').text('Approval Comments', 50, yPos);
          doc.font('Helvetica');
          yPos += 18;
          approvalComments.forEach((c) => {
            if (yPos > 750) { doc.addPage(); yPos = 50; }
            doc.fontSize(9).fillColor(OFORM.ink).font('Helvetica-Bold').text(`${c.name}:`, 55, yPos);
            doc.font('Helvetica');
            yPos += 14;
            doc.fontSize(9).fillColor('#4b5563').text(c.comment, 65, yPos, { width: pageWidth - 30 });
            yPos += Math.ceil(c.comment.length / 80) * 14 + 8;
          });
          yPos += 5;
        }
      }

      // ── Attached Documents ──
      if (request.documents && request.documents.length > 0) {
        if (yPos > 650) {
          doc.addPage();
          yPos = 50;
        }

        doc.fontSize(12).fillColor('#374151').text('Attached Documents', 50, yPos);
        yPos += 20;

        request.documents.forEach((docItem: any, idx: number) => {
          if (yPos > 750) {
            doc.addPage();
            yPos = 50;
          }
          doc.fontSize(9).fillColor('#6b7280').text(`${idx + 1}.`, 50, yPos);
          doc.fontSize(9).fillColor('#111827').text(docItem.filename, 70, yPos);
          doc.fontSize(8).fillColor('#9ca3af').text(formatDate(docItem.created_at), 400, yPos);
          yPos += 18;
        });

        yPos += 10;
      }

      // ── Footer ──
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }

      doc.moveTo(50, yPos + 20).lineTo(545, yPos + 20).strokeColor('#e5e7eb').lineWidth(1).stroke();

      doc.fontSize(9).fillColor('#9ca3af').text(
        'This document certifies that the above request has been reviewed and approved by all required approvers.',
        50,
        yPos + 35,
        { width: pageWidth, align: 'center' }
      );

      doc.fontSize(8).fillColor('#9ca3af').text(
        'The Circle - Approval Management System - Rainbow Tourism Group Ltd',
        50,
        yPos + 55,
        { width: pageWidth, align: 'center' }
      );

      doc.fontSize(7).fillColor('#9ca3af').text(
        `Generated from The Circle on ${formatDateTime(new Date().toISOString())}  |  Document ID: ${request.id}`,
        50,
        yPos + 70,
        { width: pageWidth, align: 'center' }
      );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
