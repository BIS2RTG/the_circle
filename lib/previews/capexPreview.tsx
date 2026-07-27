import React from 'react';
import type { PreviewSection, DocumentHeader } from '../../components/ui';
import { CAPEX_APPROVAL_SECTIONS } from '../capexApproval';

/**
 * Shared renderer for the CAPEX document preview — the plain black-and-white
 * RTG "Capital Expenditure Form" layout. Used by BOTH the form page's
 * pre-submission preview (pages/requests/new/capex.tsx) and the detail-page
 * preview tab (components/requests/ApprovedRequestPreview.tsx) so they render
 * identically and match the printable PDF (lib/capexPdf.ts).
 */

export interface CapexPreviewQuote {
  supplier: string;
  amount: string;
}

export interface CapexRoleSignature {
  /** Image src for the recorded signature (proxy URL or data URL). */
  url: string | null;
  /** ISO timestamp of when the approval was signed. */
  signedAt?: string | null;
}

export interface CapexPreviewInput {
  unit: string;
  department: string;
  projectName: string;
  budgetTypeDisplay: string;
  currency: string;
  budgetAmount: string;
  amountSpent: string;
  balance: string;
  projectCost: string;
  balanceAfter: string;
  justification: string;
  payback: string;
  npv: string;
  irr: string;
  evaluation: string;
  quotations: CapexPreviewQuote[];
  preferredSupplier: string;
  reason: string;
  fundingSource: string;
  requestedBy: string;
  /** roleKey -> approver display name (blank if unassigned). */
  approverNameByRole: Record<string, string>;
  /**
   * roleKey -> recorded approval signature. When present for a role, the
   * signature IMAGE is rendered on the signature line (with the approver's
   * name as a small caption underneath) and the signed date fills the DATE
   * line. Absent (e.g. pre-submission form preview, or a step not yet
   * approved) the line stays blank with the assignee's name captioned below.
   */
  approverSignatureByRole?: Record<string, CapexRoleSignature>;
}

export const capexPreviewTitle = 'Capital Expenditure Form';
/** No doc-id strip on the CAPEX form — blank all three fields to suppress it. */
export const capexPreviewDocumentHeader: DocumentHeader = { docNo: '', department: '', page: '' };

export function buildCapexPreviewSections(input: CapexPreviewInput): PreviewSection[] {
  const curr = input.currency || 'USD';
  const money = (v?: string) => `$ ${curr} ${v && String(v).trim() ? v : 'NIL'}`;
  const approverName = (key: string) => input.approverNameByRole[key] || '';

  const line: React.CSSProperties = { marginBottom: 10, fontSize: 12, color: '#111', lineHeight: 1.5 };
  const cap: React.CSSProperties = { textTransform: 'uppercase' };
  const bold: React.CSSProperties = { fontWeight: 700 };
  const noteStyle: React.CSSProperties = { fontSize: 12, color: '#111', marginBottom: 10 };
  const indent: React.CSSProperties = { paddingLeft: 40 };
  const sigRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-end', gap: 10, marginBottom: 24, fontSize: 12, color: '#111' };
  const dateLine: React.CSSProperties = { width: 100, borderBottom: '1px solid #111', paddingBottom: 2, textAlign: 'center', fontSize: 11 };

  const fmtSignedDate = (iso?: string | null) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return '';
    }
  };

  // Signature line: the approval's signature IMAGE sits on the line once the
  // role has signed; the assignee's name is a small caption BELOW the line
  // (never on it — the line itself is reserved for the signature).
  const sigRow = (label: string, key: string) => {
    const sig = input.approverSignatureByRole?.[key];
    const name = approverName(key);
    return (
      <div style={sigRowStyle} key={key}>
        <div style={{ width: 250, ...cap }}>{label}</div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ borderBottom: '1px solid #111', minHeight: 72, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 2 }}>
            {sig?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sig.url}
                alt={`${name || label} signature`}
                style={{ maxHeight: 68, maxWidth: 260, display: 'block' }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
          {name ? (
            <div style={{ fontSize: 10, color: '#555', marginTop: 2, textAlign: 'center' }}>{name}</div>
          ) : null}
        </div>
        <div>DATE</div>
        <div style={dateLine}>{sig?.signedAt ? fmtSignedDate(sig.signedAt) : ' '}</div>
      </div>
    );
  };

  const quoteSlots = Math.max(3, input.quotations.length);

  const documentSection: PreviewSection = {
    content: (
      <div style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: '#111' }}>
        <div style={line}>
          <span style={cap}>Unit: </span><span style={bold}>{input.unit || '—'}</span>
          <span style={{ ...cap, marginLeft: 40 }}>Department: </span><span style={bold}>{input.department || '—'}</span>
        </div>
        <div style={line}><span style={cap}>Description of Project: </span><span style={bold}>{input.projectName || '—'}</span></div>
        <div style={line}><span style={cap}>Budget/Non-Budget/ Emergency: </span><span style={bold}>{input.budgetTypeDisplay || '—'}</span></div>
        <div style={line}><span style={cap}>Budget Amount: </span>{money(input.budgetAmount)}</div>
        <div style={line}><span style={cap}>Amount Spent to Date: </span>{money(input.amountSpent)}</div>
        <div style={line}><span style={cap}>Balance: </span>{money(input.balance)}</div>
        <div style={line}><span style={cap}>Project Cost: </span><span style={bold}>{money(input.projectCost)}</span></div>
        <div style={line}><span style={cap}>Balance After This Purchase: </span>{money(input.balanceAfter)}</div>
        <div style={line}><span style={cap}>Justification of Project: </span><span style={bold}>{input.justification || '—'}</span></div>
        <div style={noteStyle}>(Please delete inapplicable and attach Cash Flow forecast).</div>
        <div style={line}><span style={cap}>Evaluation (for profit improvement):</span></div>
        <div style={{ ...line, ...indent }}>Payback (Years)&nbsp;&nbsp;&nbsp;{input.payback || '_______________________'}</div>
        <div style={noteStyle}>(Please attach workings)</div>
        <div style={{ ...line, ...indent }}>NPV&nbsp;&nbsp;&nbsp;{input.npv || '_______________________'}</div>
        <div style={{ ...line, ...indent }}>IRR&nbsp;&nbsp;&nbsp;{input.irr || '_______________________'}</div>
        <div style={{ ...line, ...indent }}>
          Incremented EBITDA {input.evaluation ? <span style={bold}>{input.evaluation}</span> : 'YR1_____ YR2_____ YR3_____'}
        </div>

        {Array.from({ length: quoteSlots }).map((_, i) => {
          const q = input.quotations[i];
          return (
            <div style={{ marginBottom: 10 }} key={`q${i}`}>
              <div style={{ fontSize: 12 }}>
                <span style={cap}>Quotation {i + 1}: </span>
                <span style={bold}>{q && q.amount ? `$ ${q.amount}` : ''}</span>
                <span style={{ ...bold, marginLeft: 30 }}>{q?.supplier || ''}</span>
              </div>
              <div style={{ fontSize: 11, paddingLeft: 40, color: '#333' }}>NAME OF SUPPLIER</div>
            </div>
          );
        })}
        <div style={line}><span style={cap}>Preferred Quotation </span><span style={bold}>{input.preferredSupplier || '—'}</span></div>
        <div style={line}><span style={cap}>Reason: </span><span style={bold}>{input.reason || '—'}</span></div>
        <div style={line}><span style={cap}>Project Funded From: </span>{input.fundingSource || '—'}</div>
        <div style={line}><span style={cap}>Project Requested By: </span>{input.requestedBy || '—'}</div>

        <div style={{ height: 10 }} />
        {CAPEX_APPROVAL_SECTIONS[0].roles.map(r => sigRow(r.label, r.key))}

        <div style={{ ...line, ...cap, marginTop: 6, ...bold }}>Project Approved By:</div>
        <div style={{ height: 6 }} />
        {CAPEX_APPROVAL_SECTIONS[1].roles.map(r => sigRow(r.label, r.key))}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 30, paddingTop: 8, borderTop: '1px solid #ddd', color: '#c00', fontWeight: 700, fontSize: 12 }}>
          <span>Version 5</span>
          <span>Issue Date: 01 May 2026</span>
        </div>
      </div>
    ),
  };

  return [documentSection];
}
