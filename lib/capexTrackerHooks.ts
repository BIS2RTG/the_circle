import { supabaseAdmin } from './supabaseAdmin';

export type CapexTrackerStatus =
  | 'Pending Approval'
  | 'CAPEX Approval in Progress'
  | 'CAPEX Approved – Awaiting Funding'
  | 'Procurement in Progress'
  | 'Funding Partially Allocated'
  | 'Fully Funded'
  | 'Completed'
  | 'CAPEX Rejected'
  | 'On Hold';

export const CAPEX_STATUSES: CapexTrackerStatus[] = [
  'Pending Approval',
  'CAPEX Approval in Progress',
  'CAPEX Approved – Awaiting Funding',
  'Procurement in Progress',
  'Funding Partially Allocated',
  'Fully Funded',
  'Completed',
  'CAPEX Rejected',
  'On Hold',
];

function resolveSupplier(metadata: any): string | null {
  const quotations = Array.isArray(metadata?.quotations) ? metadata.quotations : [];
  if (quotations.length === 0) return null;
  const selected = quotations.find((q: any) => q?.isSelectedSupplier === true);
  const picked = selected || quotations[0];
  const name = picked?.supplierName;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

function generateSupplierCode(): string {
  // Short, human-readable business id e.g. "SUP-K3F9Q2".
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SUP-${rand}`;
}

// Record (upsert) every supplier named on a CAPEX request into the suppliers
// directory so the CAPEX form can suggest them next time. Deduped by
// case-insensitive name within the organization. Best-effort — never throws.
export async function recordCapexSuppliers(
  metadata: any,
  organizationId: string,
  actorId: string,
  requestId: string
): Promise<void> {
  try {
    const quotations = Array.isArray(metadata?.quotations) ? metadata.quotations : [];
    if (quotations.length === 0) return;

    // Fallback currency for quotations saved before per-quotation currencies
    // existed — those were priced in the CAPEX's own currency.
    const fallbackCurrency =
      typeof metadata?.currency === 'string' && metadata.currency.trim()
        ? metadata.currency.trim()
        : 'USD';
    const products =
      (metadata?.projectName || metadata?.description || '').toString().slice(0, 500) || null;

    const seen = new Set<string>();
    for (const q of quotations) {
      const name = typeof q?.supplierName === 'string' ? q.supplierName.trim() : '';
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // The supplier quotes in ITS own currency, not necessarily the CAPEX's.
      const currency =
        typeof q?.currency === 'string' && q.currency.trim() ? q.currency.trim() : fallbackCurrency;

      // Escape LIKE wildcards before the case-insensitive exact-match lookup.
      const safe = name.replace(/[%_]/g, (m: string) => `\\${m}`);
      const { data: existing } = await supabaseAdmin
        .from('suppliers')
        .select('id, times_used')
        .eq('organization_id', organizationId)
        .ilike('name', safe)
        .maybeSingle();

      if (existing) {
        await supabaseAdmin
          .from('suppliers')
          .update({
            currency,
            products,
            last_request_id: requestId,
            times_used: (existing.times_used || 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        const { error: insErr } = await supabaseAdmin.from('suppliers').insert({
          organization_id: organizationId,
          supplier_code: generateSupplierCode(),
          name,
          products,
          currency,
          last_request_id: requestId,
          times_used: 1,
          created_by: actorId,
        });
        if (insErr) {
          console.error('[capexTrackerHooks] failed to insert supplier:', insErr, name);
        }
      }
    }
  } catch (err) {
    console.error('[capexTrackerHooks] recordCapexSuppliers unexpected error:', err);
  }
}

function deriveFinancialYear(metadata: any, submittedAt: Date): number {
  const startDate = metadata?.startDate;
  if (typeof startDate === 'string' && startDate.length >= 4) {
    const parsed = new Date(startDate);
    if (!isNaN(parsed.getTime())) return parsed.getFullYear();
  }
  return submittedAt.getFullYear();
}

function deriveCapexDate(metadata: any, submittedAt: Date): string {
  const startDate = metadata?.startDate;
  if (typeof startDate === 'string' && startDate.length >= 4) {
    const parsed = new Date(startDate);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return submittedAt.toISOString().slice(0, 10);
}

export async function createCapexTrackerRow(
  requestId: string,
  organizationId: string,
  actorId: string
): Promise<void> {
  try {
    const { data: request, error: reqErr } = await supabaseAdmin
      .from('requests')
      .select('id, creator_id, organization_id, metadata, created_at')
      .eq('id', requestId)
      .single();

    if (reqErr || !request) {
      console.error('[capexTrackerHooks] request not found for tracker creation:', requestId, reqErr);
      return;
    }

    const metadata: any = request.metadata || {};
    const type = metadata.type || metadata.requestType;
    if (type !== 'capex') return;

    // Record the request's suppliers into the suppliers directory (powers the
    // CAPEX form autocomplete). Done before the tracker-exists short-circuit so
    // re-submissions keep the directory fresh. Best-effort.
    await recordCapexSuppliers(metadata, organizationId, actorId, requestId);

    const { data: existing } = await supabaseAdmin
      .from('capex_tracker')
      .select('id')
      .eq('request_id', requestId)
      .maybeSingle();
    if (existing) return;

    const submittedAt = request.created_at ? new Date(request.created_at) : new Date();
    // Amounts from the form carry thousands separators (e.g. "3,434"), which
    // Number() turns into NaN — strip everything but digits and the decimal point.
    const cost = Number(String(metadata.amount ?? '0').replace(/[^0-9.]/g, '') || 0);
    if (!Number.isFinite(cost) || cost < 0) {
      console.error('[capexTrackerHooks] invalid cost on request', requestId, metadata.amount);
      return;
    }

    const row = {
      request_id: requestId,
      organization_id: organizationId,
      ranking: null,
      supplier: resolveSupplier(metadata),
      description: (metadata.projectName || metadata.description || 'CAPEX Request').toString().slice(0, 500),
      capex_date: deriveCapexDate(metadata, submittedAt),
      cost,
      funded: 0,
      champion_user_id: request.creator_id,
      status_update: 'CAPEX Approval in Progress' as CapexTrackerStatus,
      department: metadata.department || null,
      business_unit: metadata.unit || null,
      financial_year: deriveFinancialYear(metadata, submittedAt),
      is_budgeted: metadata.isBudgeted !== false,
      created_by: actorId,
      last_updated_by: actorId,
    };

    const { error: insertErr } = await supabaseAdmin.from('capex_tracker').insert(row);
    if (insertErr) {
      console.error('[capexTrackerHooks] failed to insert tracker row:', insertErr, row);
    }
  } catch (err) {
    console.error('[capexTrackerHooks] createCapexTrackerRow unexpected error:', err);
  }
}

async function updateCapexTrackerStatus(
  requestId: string,
  newStatus: CapexTrackerStatus,
  actorId: string
): Promise<void> {
  try {
    const { data: request } = await supabaseAdmin
      .from('requests')
      .select('id, metadata')
      .eq('id', requestId)
      .single();

    if (!request) return;
    const metadata: any = request.metadata || {};
    const type = metadata.type || metadata.requestType;
    if (type !== 'capex') return;

    const { error } = await supabaseAdmin
      .from('capex_tracker')
      .update({
        status_update: newStatus,
        last_updated_by: actorId,
        last_updated_at: new Date().toISOString(),
      })
      .eq('request_id', requestId);

    if (error) {
      console.error('[capexTrackerHooks] failed to update tracker status:', error, { requestId, newStatus });
    }
  } catch (err) {
    console.error('[capexTrackerHooks] updateCapexTrackerStatus unexpected error:', err);
  }
}

export async function onCapexApproved(requestId: string, actorId: string): Promise<void> {
  await updateCapexTrackerStatus(requestId, 'CAPEX Approved – Awaiting Funding', actorId);
}

export async function onCapexRejected(requestId: string, actorId: string): Promise<void> {
  await updateCapexTrackerStatus(requestId, 'CAPEX Rejected', actorId);
}

// Fired when a previously-rejected CAPEX request is resubmitted. Returns the
// tracker row from 'CAPEX Rejected' back into the active approval pipeline so
// the tracker reflects that the request is live again. No-ops for non-CAPEX
// requests (guarded inside updateCapexTrackerStatus).
export async function onCapexResubmitted(requestId: string, actorId: string): Promise<void> {
  await updateCapexTrackerStatus(requestId, 'CAPEX Approval in Progress', actorId);
}

// Fired when a CAPEX request is cancelled (by the requester or an approver,
// at any stage including after full approval). There is no dedicated
// 'Cancelled' tracker state, so the row is moved to 'On Hold' to take it out
// of the active funding pipeline. No-ops for non-CAPEX requests.
export async function onCapexCancelled(requestId: string, actorId: string): Promise<void> {
  await updateCapexTrackerStatus(requestId, 'On Hold', actorId);
}
