import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';
import { signatureExists, userSignaturePath, userSignatureProxyUrl } from '../../../../lib/signatureStorage';

const UNIT_LABELS: Record<string, string> = {
  CORP: 'Corporate (CORP)',
  MRC: 'Montclair Resort and Conferencing (MRC)',
  NAH: 'New Ambassador Hotel (NAH)',
  RTH: 'Rainbow Towers Hotel (RTH)',
  KHCC: 'KHCC Conference Centre (KHCC)',
  BRH: 'Bulawayo Rainbow Hotel (BRH)',
  VFRH: 'Victoria Falls Rainbow Hotel (VFRH)',
  AZAM: "A'Zambezi River Lodge (AZAM)",
};

const escapeHtml = (input: any): string => {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const formatMoney = (value: any): string => {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });

    const user = session.user as any;
    const organizationId = user.org_id;
    const userId = user.id;
    const { id } = req.query;

    if (!organizationId) return res.status(400).json({ error: 'Organization ID not found' });
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Request ID is required' });

    const { data: request, error } = await supabaseAdmin
      .from('requests')
      .select(`
        id, title, description, status, metadata, created_at, updated_at, creator_id,
        creator:app_users!requests_creator_id_fkey ( id, display_name, email, job_title ),
        request_steps (
          id, step_index, step_type, approver_role, approver_user_id, status, due_at, created_at,
          approver:app_users!request_steps_approver_user_id_fkey ( id, display_name, email, signature_url ),
          approvals (
            id, decision, comment, signed_at,
            approver:app_users!approvals_approver_id_fkey ( id, display_name, email )
          )
        )
      `)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Request not found' });
      throw error;
    }

    const requestType = request.metadata?.type || request.metadata?.requestType;
    if (requestType !== 'inter_unit_debit_note') {
      return res.status(400).json({ error: 'This endpoint is only for inter-unit debit notes' });
    }

    const isCreator = request.creator_id === userId;
    const watcherIds = request.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) =>
      typeof w === 'string' ? w === userId : w?.id === userId
    );
    const userStep = request.request_steps?.find((step: any) => step.approver_user_id === userId);
    const canApproverView = userStep && userStep.status !== 'waiting';

    if (!isCreator && !isWatcher && !canApproverView) {
      return res.status(403).json({ error: 'You do not have permission to view this debit note' });
    }

    // Resolve signatures for each approval step (HTML rendered in the browser,
    // so the private-bucket proxy URL is used).
    for (const step of (request.request_steps || [])) {
      if (step.approver_user_id) {
        if (await signatureExists(userSignaturePath(step.approver_user_id))) {
          (step as any).resolved_signature_url = userSignatureProxyUrl(step.approver_user_id);
        }
      }
    }

    const html = generateDebitNoteHtml(request);

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="debit-note-${id}.html"`);
    return res.status(200).send(html);
  } catch (err: any) {
    console.error('Debit note PDF generation error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate debit note PDF' });
  }
}

function getApproverField(step: any, field: string) {
  if (!step?.approver) return null;
  const approver = Array.isArray(step.approver) ? step.approver[0] : step.approver;
  return approver?.[field] || null;
}

function generateDebitNoteHtml(request: any): string {
  const metadata = request.metadata || {};
  const lineItems: Array<{ qty: string; description: string; invoiceNo: string; amount: string }> = Array.isArray(metadata.lineItems) ? metadata.lineItems : [];
  const currency = metadata.currency || 'USD';
  const fromUnitLabel = UNIT_LABELS[metadata.fromUnit] || metadata.fromUnit || '—';
  const toUnitLabel = UNIT_LABELS[metadata.toUnit] || metadata.toUnit || '—';

  const lineTotalFor = (r: { qty: string; amount: string }) =>
    (parseFloat(r.qty) || 0) * (parseFloat(r.amount) || 0);

  const totalAmount = metadata.totalAmount
    ? formatMoney(metadata.totalAmount)
    : formatMoney(lineItems.reduce((sum, r) => sum + lineTotalFor(r), 0));

  // Approval steps mapped to the role keys captured at submission time. The
  // From-Unit Accountant slot is the requestor — they're treated as having
  // signed on submission, so we surface their stored signature as the cell.
  const approverRoles = metadata.approverRoles || {};
  const steps: any[] = request.request_steps || [];
  const stepByUserId = (uid: string) => steps.find((s: any) => s.approver_user_id === uid);

  const fromAccountantStep = stepByUserId(approverRoles.from_accountant);
  const fromFinanceManagerStep = stepByUserId(approverRoles.from_finance_manager);
  const toAccountantStep = stepByUserId(approverRoles.to_accountant);

  const renderApprovalCell = (label: string, step: any, fallbackName: string) => {
    const name = getApproverField(step, 'display_name') || fallbackName || '—';
    const signature = step?.resolved_signature_url || getApproverField(step, 'signature_url');
    const decision = step?.approvals?.[0];
    const signedAt = decision?.signed_at ? new Date(decision.signed_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const isApproved = step?.status === 'approved';

    return `
      <td class="sig-cell">
        <div class="sig-label">${escapeHtml(label)}</div>
        <div class="sig-box">
          ${signature && isApproved ? `<img src="${escapeHtml(signature)}" alt="Signature" />` : '<span class="sig-placeholder">Pending signature</span>'}
        </div>
        <div class="sig-name">${escapeHtml(name)}</div>
        <div class="sig-date">${signedAt ? `Signed: ${escapeHtml(signedAt)}` : ''}</div>
      </td>
    `;
  };

  const dnNumber = metadata.debitNoteNumber || '—';
  const refCode = metadata.referenceCode || '';
  const docDate = metadata.date || (request.created_at ? new Date(request.created_at).toISOString().split('T')[0] : '');

  const rowsHtml = (lineItems.length > 0 ? lineItems : [{ qty: '', description: '', invoiceNo: '', amount: '' }])
    .map((row) => {
      const hasLine = row.qty && row.amount;
      return `
      <tr>
        <td class="num">${escapeHtml(row.qty || '')}</td>
        <td>${escapeHtml(row.description || '')}</td>
        <td>${escapeHtml(row.invoiceNo || '')}</td>
        <td class="num">${row.amount ? escapeHtml(formatMoney(row.amount)) : ''}</td>
        <td class="num">${hasLine ? escapeHtml(formatMoney(lineTotalFor(row as any))) : ''}</td>
      </tr>
    `;
    }).join('');

  // Pad to a minimum of 8 rows so the printed sheet looks like the paper form.
  const padding = Math.max(0, 8 - lineItems.length);
  const paddingRows = Array.from({ length: padding }).map(() => `
    <tr>
      <td class="num">&nbsp;</td>
      <td>&nbsp;</td>
      <td>&nbsp;</td>
      <td class="num">&nbsp;</td>
      <td class="num">&nbsp;</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Inter-Unit Debit Note - ${escapeHtml(dnNumber)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #f3f1ec;
      font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
      color: #1c1c1c;
    }
    .toolbar {
      max-width: 820px;
      margin: 24px auto 0;
      padding: 0 20px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn {
      background: #9A7545;
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.02em;
    }
    .btn.secondary {
      background: #fff;
      color: #5E4426;
      border: 1px solid #C9B896;
    }
    .sheet {
      max-width: 820px;
      margin: 20px auto 60px;
      background: #fff;
      padding: 36px 44px;
      border: 1px solid #d9d3c4;
      box-shadow: 0 12px 32px rgba(40, 30, 10, 0.06);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #1c1c1c;
      padding-bottom: 12px;
      margin-bottom: 22px;
    }
    .header .company {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #6f5b3d;
      margin-top: 6px;
    }
    .title {
      text-align: center;
      letter-spacing: 0.18em;
      font-weight: 700;
      font-size: 22px;
      text-transform: uppercase;
    }
    .ref {
      text-align: right;
      font-size: 11px;
      color: #6f5b3d;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .ref strong {
      display: block;
      font-size: 13px;
      color: #1c1c1c;
      letter-spacing: 0.04em;
      margin-top: 2px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0;
      border: 1px solid #1c1c1c;
      margin-bottom: 20px;
    }
    .meta-cell {
      padding: 10px 14px;
      border-right: 1px solid #1c1c1c;
      border-bottom: 1px solid #1c1c1c;
      min-height: 56px;
    }
    .meta-cell:nth-child(2n) { border-right: none; }
    .meta-cell:nth-last-child(-n+2) { border-bottom: none; }
    .meta-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #6f5b3d;
      margin-bottom: 4px;
      font-weight: 600;
    }
    .meta-value {
      font-size: 14px;
      font-weight: 500;
      color: #1c1c1c;
    }
    table.line-items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 18px;
      font-size: 12.5px;
    }
    table.line-items th, table.line-items td {
      border: 1px solid #1c1c1c;
      padding: 8px 10px;
      vertical-align: top;
    }
    table.line-items thead th {
      background: #F3EADC;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 11px;
      font-weight: 700;
      color: #3F2D19;
    }
    table.line-items td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.line-items td.num:first-child { text-align: center; }
    table.line-items tr.total td {
      background: #F3EADC;
      font-weight: 700;
      font-size: 13px;
    }
    .remarks {
      border: 1px solid #1c1c1c;
      padding: 12px 14px;
      margin-bottom: 22px;
      min-height: 80px;
    }
    .remarks .meta-label { margin-bottom: 6px; }
    .remarks p {
      margin: 0;
      font-size: 13px;
      white-space: pre-wrap;
      line-height: 1.5;
    }
    table.signatures {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }
    table.signatures td.sig-cell {
      border: 1px solid #1c1c1c;
      padding: 10px 12px;
      width: 25%;
      vertical-align: top;
      text-align: center;
    }
    .sig-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #6f5b3d;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .sig-box {
      height: 70px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid #1c1c1c;
      margin-bottom: 6px;
    }
    .sig-box img {
      max-width: 100%;
      max-height: 64px;
      object-fit: contain;
    }
    .sig-placeholder {
      font-size: 11px;
      color: #aaa;
      font-style: italic;
    }
    .sig-name {
      font-size: 12px;
      font-weight: 600;
      color: #1c1c1c;
    }
    .sig-date {
      font-size: 10px;
      color: #6f5b3d;
      margin-top: 2px;
      min-height: 12px;
    }
    .footer-note {
      margin-top: 28px;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #6f5b3d;
      text-align: center;
    }
    @media print {
      body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .toolbar, .no-print { display: none !important; }
      .sheet {
        box-shadow: none;
        border: none;
        margin: 0;
        padding: 12mm 14mm;
        max-width: none;
      }
      @page { size: A4; margin: 10mm; }
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <button class="btn secondary" onclick="window.history.back()">Back</button>
    <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="sheet">
    <div class="header">
      <div>
        <div class="title">Inter-Unit Debit Note</div>
        <div class="company">Rainbow Tourism Group</div>
      </div>
      <div class="ref">
        Reference
        <strong>${escapeHtml(refCode || dnNumber)}</strong>
      </div>
    </div>

    <div class="meta-grid">
      <div class="meta-cell">
        <div class="meta-label">Date</div>
        <div class="meta-value">${escapeHtml(docDate)}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-label">Debit Note No. (DN No.)</div>
        <div class="meta-value">${escapeHtml(dnNumber)}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-label">To (Receiving Accountant / Unit)</div>
        <div class="meta-value">${escapeHtml(metadata.toAccountant || '—')}<br /><small style="color:#6f5b3d">${escapeHtml(toUnitLabel)}</small></div>
      </div>
      <div class="meta-cell">
        <div class="meta-label">From Accountant / Unit</div>
        <div class="meta-value">${escapeHtml(metadata.fromAccountant || '—')}<br /><small style="color:#6f5b3d">${escapeHtml(fromUnitLabel)}</small></div>
      </div>
      <div class="meta-cell" style="grid-column: span 2; border-right: none;">
        <div class="meta-label">Currency</div>
        <div class="meta-value">${escapeHtml(currency)}</div>
      </div>
    </div>

    <table class="line-items">
      <thead>
        <tr>
          <th style="width: 8%;">Qty</th>
          <th>Detail / Description</th>
          <th style="width: 18%;">Invoice No.</th>
          <th style="width: 14%;">Unit Price (${escapeHtml(currency)})</th>
          <th style="width: 16%;">Line Total (${escapeHtml(currency)})</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        ${paddingRows}
        <tr class="total">
          <td colspan="4" style="text-align: right;">TOTAL</td>
          <td class="num">${escapeHtml(currency)} ${escapeHtml(totalAmount)}</td>
        </tr>
      </tbody>
    </table>

    <div class="remarks">
      <div class="meta-label">Remarks / Reference</div>
      <p>${escapeHtml(metadata.remarks || '')}</p>
    </div>

    <table class="signatures">
      <tr>
        ${renderApprovalCell('From Unit Accountant (Requestor)', fromAccountantStep, metadata.fromAccountant || '')}
        ${renderApprovalCell('From Unit Finance Manager', fromFinanceManagerStep, '')}
        ${renderApprovalCell('Receiving Unit Accountant', toAccountantStep, metadata.toAccountant || '')}
      </tr>
    </table>

    <div class="footer-note">FIN APX – Inter-Unit Debit Note</div>
  </div>
</body>
</html>`;
}
