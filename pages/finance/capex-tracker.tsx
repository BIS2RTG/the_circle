import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { AppLayout } from '../../components/layout';
import { Card, Button, ScopeBanner } from '../../components/ui';
import type { ResponseScope } from '../../components/ui';
import { useRBAC } from '../../contexts/RBACContext';
import { formatDateTime } from '@/lib/formatDate';
import { useToast } from '../../components/ui/ToastProvider';
import { CAPEX_STATUSES, CapexTrackerStatus } from '../../lib/capexTrackerHooks';

interface ApproverRef {
  id: string;
  display_name: string | null;
  email: string | null;
}

interface TrackerStep {
  id: string;
  step_index: number;
  status: string;
  approver_user_id: string | null;
  approver: ApproverRef | null;
}

interface TrackerEntry {
  id: string;
  request_id: string | null;
  ranking: number | null;
  supplier: string | null;
  description: string;
  capex_date: string;
  cost: number;
  funded: number;
  balance: number;
  champion_user_id: string | null;
  status_update: CapexTrackerStatus;
  department: string | null;
  business_unit: string | null;
  financial_year: number;
  is_budgeted: boolean;
  champion: ApproverRef | null;
  steps: TrackerStep[];
  creator_id: string | null;
  approver_roles: Record<string, string>;
  request_priority: string | null;
}

type StatusDisplay = {
  text: string;
  tone: 'pending' | 'progress' | 'approved' | 'funded' | 'done' | 'rejected' | 'hold';
};

// CEO is intentionally never named — the requirement is to show "Final CEO Approval" instead.
function deriveStatusDisplay(entry: TrackerEntry): StatusDisplay {
  const steps = entry.steps || [];
  const approverRoleMap = entry.approver_roles || {};

  if (steps.length > 0) {
    const hasRejected = steps.some(s => s.status === 'rejected');
    if (hasRejected) return { text: 'Rejected', tone: 'rejected' };

    const allApproved = steps.every(s => s.status === 'approved');
    if (!allApproved) {
      // Find the next signer — the first step that's still pending/waiting
      const next = steps.find(s => s.status === 'pending') || steps.find(s => s.status === 'waiting');
      if (next) {
        const isCeoStep = approverRoleMap.ceo && next.approver_user_id === approverRoleMap.ceo;
        if (isCeoStep) {
          return { text: 'Awaiting Final CEO Approval', tone: 'progress' };
        }
        const name = next.approver?.display_name || 'Unknown approver';
        return { text: `Pending: ${name}`, tone: 'progress' };
      }
    }
  }

  // Either fully approved (all steps approved) or no steps present — fall back to the
  // tracker.status_update column, which captures the post-approval funding lifecycle.
  const status = entry.status_update;
  if (status === 'Fully Funded') return { text: 'Fully Funded', tone: 'funded' };
  if (status === 'Completed') return { text: 'Done', tone: 'done' };
  if (status === 'CAPEX Approved – Awaiting Funding') return { text: 'Awaiting Funding', tone: 'approved' };
  if (status === 'Funding Partially Allocated') return { text: 'Funding Partially Allocated', tone: 'approved' };
  if (status === 'Procurement in Progress') return { text: 'Procurement in Progress', tone: 'approved' };
  if (status === 'On Hold') return { text: 'On Hold', tone: 'hold' };
  if (status === 'CAPEX Rejected') return { text: 'Rejected', tone: 'rejected' };
  if (status === 'CAPEX Approval in Progress') return { text: 'CAPEX Approval in Progress', tone: 'progress' };
  return { text: status || 'Pending', tone: 'pending' };
}

function toneClasses(tone: StatusDisplay['tone']): string {
  switch (tone) {
    case 'pending': return 'bg-gray-100 text-gray-700 border-gray-200';
    case 'progress': return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'approved': return 'bg-sky-50 text-sky-700 border-sky-200';
    case 'funded': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'done': return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'rejected': return 'bg-rose-50 text-rose-700 border-rose-200';
    case 'hold': return 'bg-slate-100 text-slate-700 border-slate-300';
  }
}

function priorityDisplay(entry: TrackerEntry): { label: string; cls: string } {
  // Prefer the explicit priority captured on the originating request; fall back to legacy `ranking`.
  const p = (entry.request_priority || '').toLowerCase();
  if (p === 'critical') return { label: 'Critical', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
  if (p === 'high') return { label: 'High', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  if (p === 'medium') return { label: 'Medium', cls: 'bg-sky-50 text-sky-700 border-sky-200' };
  if (p === 'low') return { label: 'Low', cls: 'bg-gray-50 text-gray-700 border-gray-200' };
  const r = entry.ranking;
  if (r === 1) return { label: 'Critical', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
  if (r === 2) return { label: 'High', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  if (r === 3) return { label: 'Medium', cls: 'bg-sky-50 text-sky-700 border-sky-200' };
  if (r === 4) return { label: 'Low', cls: 'bg-gray-50 text-gray-700 border-gray-200' };
  return { label: 'Unranked', cls: 'bg-gray-50 text-gray-500 border-gray-200' };
}

function formatMoney(n: number, currency = 'USD'): string {
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
}

function formatDate(d: string): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const FUNDING_STATUSES: CapexTrackerStatus[] = [
  'CAPEX Approved – Awaiting Funding',
  'Procurement in Progress',
  'Funding Partially Allocated',
  'Fully Funded',
  'Completed',
  'On Hold',
];

type SortKey = 'priority' | 'supplier' | 'description' | 'capex_date' | 'cost' | 'balance' | 'champion' | 'status';
type SortDir = 'asc' | 'desc';

interface ColumnDef {
  key: SortKey;
  label: string;
  align?: 'left' | 'right';
}

const COLUMN_DEFS: ColumnDef[] = [
  { key: 'priority',    label: 'Priority/Urgency' },
  { key: 'supplier',    label: 'Supplier' },
  { key: 'description', label: 'Description' },
  { key: 'capex_date',  label: 'Capex Date' },
  { key: 'cost',        label: 'Cost', align: 'right' },
  { key: 'balance',     label: 'Balance', align: 'right' },
  { key: 'champion',    label: 'Champion' },
  { key: 'status',      label: 'Status Update' },
];

// Plain header list used by exporters (keeps column order in sync with the on-screen table)
const COLUMNS = COLUMN_DEFS.map(c => c.label);

// Approval stage filter — coarser-grained than the raw status_update value.
type ApprovalStage = '' | 'in_progress' | 'awaiting_funding' | 'fully_funded' | 'rejected' | 'on_hold';

const APPROVAL_STAGE_OPTIONS: Array<{ value: ApprovalStage; label: string }> = [
  { value: '',                  label: 'All approval stages' },
  { value: 'in_progress',       label: 'Approval in progress' },
  { value: 'awaiting_funding',  label: 'Awaiting / Partial funding' },
  { value: 'fully_funded',      label: 'Fully funded / Done' },
  { value: 'on_hold',           label: 'On hold' },
  { value: 'rejected',          label: 'Rejected' },
];

// Period filter — relative to "now", matched against an entry's capex_date.
const PERIOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',             label: 'All time' },
  { value: 'week',         label: 'This week' },
  { value: 'last_week',    label: 'Last week' },
  { value: 'month',        label: 'This month' },
  { value: 'last_month',   label: 'Last month' },
  { value: 'quarter',      label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'year',         label: 'This year' },
  { value: 'last_year',    label: 'Last year' },
];

function startOfWeek(d: Date): Date {
  // Week starts Monday.
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

function periodRange(period: string): { start: Date; end: Date } | null {
  if (!period) return null;
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3);
  const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  switch (period) {
    case 'week': {
      const s = startOfWeek(now);
      return { start: s, end: endOfDay(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6)) };
    }
    case 'last_week': {
      const s = startOfWeek(now); s.setDate(s.getDate() - 7);
      return { start: s, end: endOfDay(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6)) };
    }
    case 'month':       return { start: new Date(y, m, 1), end: endOfDay(new Date(y, m + 1, 0)) };
    case 'last_month':  return { start: new Date(y, m - 1, 1), end: endOfDay(new Date(y, m, 0)) };
    case 'quarter':     return { start: new Date(y, q * 3, 1), end: endOfDay(new Date(y, q * 3 + 3, 0)) };
    case 'last_quarter': {
      const lq = q - 1;
      const yy = lq < 0 ? y - 1 : y;
      const qq = (lq + 4) % 4;
      return { start: new Date(yy, qq * 3, 1), end: endOfDay(new Date(yy, qq * 3 + 3, 0)) };
    }
    case 'year':        return { start: new Date(y, 0, 1), end: endOfDay(new Date(y, 11, 31)) };
    case 'last_year':   return { start: new Date(y - 1, 0, 1), end: endOfDay(new Date(y - 1, 11, 31)) };
    default:            return null;
  }
}

function priorityRank(entry: TrackerEntry): number {
  // Numeric rank so "Priority" can be sorted naturally (Critical = highest).
  const p = (entry.request_priority || '').toLowerCase();
  if (p === 'critical') return 4;
  if (p === 'high') return 3;
  if (p === 'medium') return 2;
  if (p === 'low') return 1;
  const r = entry.ranking;
  if (r === 1) return 4;
  if (r === 2) return 3;
  if (r === 3) return 2;
  if (r === 4) return 1;
  return 0;
}

function approvalStage(entry: TrackerEntry): Exclude<ApprovalStage, ''> {
  const steps = entry.steps || [];
  if (steps.some(s => s.status === 'rejected') || entry.status_update === 'CAPEX Rejected') return 'rejected';
  if (entry.status_update === 'On Hold') return 'on_hold';
  if (steps.length > 0 && !steps.every(s => s.status === 'approved')) return 'in_progress';
  if (entry.status_update === 'Fully Funded' || entry.status_update === 'Completed') return 'fully_funded';
  if (
    entry.status_update === 'CAPEX Approved – Awaiting Funding' ||
    entry.status_update === 'Funding Partially Allocated' ||
    entry.status_update === 'Procurement in Progress'
  ) return 'awaiting_funding';
  return 'in_progress';
}

export default function CapexTrackerPage() {
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();
  const { hasPermission, loading: rbacLoading } = useRBAC();
  const { addToast } = useToast();

  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [dataScope, setDataScope] = useState<ResponseScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('');
  const [businessUnitFilter, setBusinessUnitFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [stageFilter, setStageFilter] = useState<ApprovalStage>('');
  const [yearFilter, setYearFilter] = useState<string>('');
  const [periodFilter, setPeriodFilter] = useState<string>('');
  const [minCost, setMinCost] = useState<string>('');
  const [maxCost, setMaxCost] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortKey>('priority');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TrackerEntry | null>(null);
  const [editFunded, setEditFunded] = useState('');
  const [editStatus, setEditStatus] = useState<CapexTrackerStatus>('CAPEX Approved – Awaiting Funding');

  const sessionUserId = (session?.user as any)?.id as string | undefined;

  useEffect(() => {
    if (sessionStatus === 'unauthenticated') router.push('/');
  }, [sessionStatus, router]);

  const fetchEntries = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/finance/capex-tracker');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error || `HTTP ${res.status}`;
        console.error('[capex-tracker] load failed', { status: res.status, body: err });
        throw new Error(msg);
      }
      const data = await res.json();
      setEntries(data.entries || []);
      setDataScope(data.scope || null);
    } catch (e: any) {
      const msg = e?.message || 'Failed to load tracker';
      setLoadError(msg);
      addToast({ type: 'error', title: 'Failed to load CAPEX tracker', message: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionStatus === 'authenticated' && hasPermission('finance.view_tracker')) {
      fetchEntries();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, rbacLoading]);

  const departments = useMemo(() => {
    const s = new Set<string>();
    entries.forEach(e => { if (e.department) s.add(e.department); });
    return Array.from(s).sort();
  }, [entries]);

  const businessUnits = useMemo(() => {
    const s = new Set<string>();
    entries.forEach(e => { if (e.business_unit) s.add(e.business_unit); });
    return Array.from(s).sort();
  }, [entries]);

  const financialYears = useMemo(() => {
    const s = new Set<number>();
    entries.forEach(e => { if (Number.isFinite(e.financial_year)) s.add(e.financial_year); });
    return Array.from(s).sort((a, b) => b - a);
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const term = search.trim().toLowerCase();
    const minN = minCost.trim() === '' ? -Infinity : Number(minCost);
    const maxN = maxCost.trim() === '' ? Infinity : Number(maxCost);
    const range = periodRange(periodFilter);
    return entries.filter(e => {
      if (statusFilter && e.status_update !== statusFilter) return false;
      if (departmentFilter && e.department !== departmentFilter) return false;
      if (businessUnitFilter && e.business_unit !== businessUnitFilter) return false;
      if (priorityFilter && (e.request_priority || '').toLowerCase() !== priorityFilter) return false;
      if (stageFilter && approvalStage(e) !== stageFilter) return false;
      if (yearFilter && String(e.financial_year) !== yearFilter) return false;
      if (range) {
        const d = new Date(e.capex_date);
        if (isNaN(d.getTime()) || d < range.start || d > range.end) return false;
      }
      const cost = Number(e.cost || 0);
      if (Number.isFinite(minN) && cost < minN) return false;
      if (Number.isFinite(maxN) && cost > maxN) return false;
      if (!term) return true;
      const hay = [
        e.supplier, e.description, e.department,
        e.champion?.display_name, e.champion?.email,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(term);
    });
  }, [entries, search, statusFilter, departmentFilter, businessUnitFilter, priorityFilter, stageFilter, yearFilter, periodFilter, minCost, maxCost]);

  const sortedEntries = useMemo(() => {
    const dirMul = sortDir === 'asc' ? 1 : -1;
    const valueOf = (e: TrackerEntry): number | string => {
      switch (sortBy) {
        case 'priority':    return priorityRank(e);
        case 'supplier':    return (e.supplier || '').toLowerCase();
        case 'description': return (e.description || '').toLowerCase();
        case 'capex_date':  return new Date(e.capex_date || 0).getTime() || 0;
        case 'cost':        return Number(e.cost || 0);
        case 'balance':     return Number(e.balance || 0);
        case 'champion':    return (e.champion?.display_name || '').toLowerCase();
        case 'status':      return deriveStatusDisplay(e).text.toLowerCase();
      }
    };
    return [...filteredEntries].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dirMul;
      return String(va).localeCompare(String(vb)) * dirMul;
    });
  }, [filteredEntries, sortBy, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      // Numeric/temporal columns default to descending (biggest/newest first); text columns to ascending.
      const numericKeys: SortKey[] = ['priority', 'capex_date', 'cost', 'balance'];
      setSortDir(numericKeys.includes(key) ? 'desc' : 'asc');
    }
  };

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('');
    setDepartmentFilter('');
    setBusinessUnitFilter('');
    setPriorityFilter('');
    setStageFilter('');
    setYearFilter('');
    setPeriodFilter('');
    setMinCost('');
    setMaxCost('');
  };

  const activeFilterCount = [
    search.trim(),
    statusFilter, departmentFilter, businessUnitFilter, priorityFilter, stageFilter, yearFilter, periodFilter,
    minCost.trim(), maxCost.trim(),
  ].filter(Boolean).length;

  // The requestor can update funding/status once the request is fully approved.
  // Detection: all steps approved, OR (no steps at all and the legacy status is post-approval).
  const isFullyApproved = (e: TrackerEntry): boolean => {
    if (e.steps && e.steps.length > 0) {
      return e.steps.every(s => s.status === 'approved');
    }
    const postApprovalStates: CapexTrackerStatus[] = [
      'CAPEX Approved – Awaiting Funding',
      'Procurement in Progress',
      'Funding Partially Allocated',
      'Fully Funded',
      'Completed',
    ];
    return postApprovalStates.includes(e.status_update);
  };

  const canUpdateFunding = (e: TrackerEntry): boolean => {
    if (!isFullyApproved(e)) return false;
    if (!sessionUserId) return false;
    // The champion (requestor) can update; so can users with edit_tracker permission (finance admin).
    if (e.champion_user_id === sessionUserId || e.creator_id === sessionUserId) return true;
    return hasPermission('finance.edit_tracker');
  };

  const openEdit = (e: TrackerEntry) => {
    setEditing(e);
    setEditFunded(String(e.funded ?? 0));
    setEditStatus(e.status_update);
  };

  const closeEdit = () => {
    setEditing(null);
    setEditFunded('');
  };

  const submitEdit = async () => {
    if (!editing) return;
    const fundedNum = Number(editFunded);
    if (!Number.isFinite(fundedNum) || fundedNum < 0) {
      addToast({ type: 'error', title: 'Invalid amount', message: 'Funded amount must be a non-negative number.' });
      return;
    }
    if (fundedNum > Number(editing.cost)) {
      addToast({ type: 'error', title: 'Invalid amount', message: 'Funded cannot exceed cost.' });
      return;
    }
    setUpdatingId(editing.id);
    try {
      const res = await fetch(`/api/finance/capex-tracker/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funded: fundedNum, status_update: editStatus }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update');
      }
      addToast({ type: 'success', title: 'Updated', message: 'Funding progress saved.' });
      closeEdit();
      await fetchEntries();
    } catch (e: any) {
      addToast({ type: 'error', title: 'Error', message: e.message || 'Failed to update' });
    } finally {
      setUpdatingId(null);
    }
  };

  // ============== EXPORT HELPERS ==============
  const buildExportRows = (): string[][] => {
    const header = [...COLUMNS];
    const rows: string[][] = [header];
    sortedEntries.forEach(e => {
      const status = deriveStatusDisplay(e);
      rows.push([
        priorityDisplay(e).label,
        e.supplier || '',
        e.description || '',
        e.capex_date || '',
        String(e.cost ?? 0),
        String(e.balance ?? 0),
        e.champion?.display_name || '',
        status.text,
      ]);
    });
    return rows;
  };

  const escapeCsv = (val: string) => {
    if (val == null) return '';
    const s = String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const downloadFile = (filename: string, mime: string, content: string | Blob) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const rows = buildExportRows();
    const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\r\n');
    downloadFile(`capex-tracker-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;', '﻿' + csv);
  };

  // Excel is generated as SpreadsheetML XML so Excel opens it natively with .xls extension —
  // avoids pulling in a heavy client-side xlsx library.
  const exportExcel = () => {
    const rows = buildExportRows();
    const escapeXml = (s: string) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xmlRows = rows.map((r, i) => {
      const cells = r.map((c, ci) => {
        const numericCol = i > 0 && (ci === 4 || ci === 5); // Cost / Balance
        if (numericCol) {
          const n = Number(c);
          if (Number.isFinite(n)) {
            return `<Cell><Data ss:Type="Number">${n}</Data></Cell>`;
          }
        }
        return `<Cell><Data ss:Type="String">${escapeXml(c)}</Data></Cell>`;
      }).join('');
      return `<Row>${cells}</Row>`;
    }).join('');
    const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="CAPEX Tracker"><Table>${xmlRows}</Table></Worksheet>
</Workbook>`;
    downloadFile(`capex-tracker-${new Date().toISOString().slice(0, 10)}.xls`,
      'application/vnd.ms-excel', xml);
  };

  // PDF is generated by opening a styled, print-ready window and triggering print —
  // the user can then choose "Save as PDF" from the OS dialog. Keeps the bundle small.
  const exportPdf = () => {
    const rows = buildExportRows();
    const w = window.open('', '_blank', 'width=1200,height=800');
    if (!w) {
      addToast({ type: 'error', title: 'Popup blocked', message: 'Please allow popups to export as PDF.' });
      return;
    }
    const logoUrl = `${window.location.origin}/images/RTG_LOGO.png`;
    const headerHtml = rows[0].map(h => `<th>${h}</th>`).join('');
    const bodyHtml = rows.slice(1).map(r => `<tr>${r.map((c, i) => {
      if (i === 4 || i === 5) {
        const n = Number(c);
        const txt = Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : c;
        return `<td style="text-align:right">${txt}</td>`;
      }
      return `<td>${(c || '').replace(/</g, '&lt;')}</td>`;
    }).join('')}</tr>`).join('');
    // Wait for the logo image to finish loading before triggering print so the
    // PDF/print preview always includes the brand mark.
    w.document.write(`<!doctype html><html><head><meta charset="utf-8" /><title>CAPEX Tracker</title>
      <style>
        @page { size: A4 landscape; margin: 12mm; }
        body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1f2937; }
        .brand-header { text-align: center; margin-bottom: 14px; }
        .brand-header img { max-height: 56px; max-width: 220px; object-fit: contain; display: inline-block; }
        h1 { font-size: 16px; margin: 8px 0 4px; text-align: center; }
        .meta { font-size: 10px; color: #6b7280; margin-bottom: 12px; text-align: center; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; }
        thead th { background: #F3EADC; color: #5E4426; text-align: left; padding: 6px 8px; border: 1px solid #C9B896; }
        tbody td { padding: 6px 8px; border: 1px solid #e5e7eb; vertical-align: top; }
        tbody tr:nth-child(even) td { background: #FAF7F0; }
      </style></head><body>
      <div class="brand-header">
        <img id="rtg-logo" src="${logoUrl}" alt="RTG" />
      </div>
      <h1>CAPEX Tracker</h1>
      <div class="meta">Generated ${formatDateTime(new Date())} · ${rows.length - 1} entries</div>
      <table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
      <script>
        (function(){
          var img = document.getElementById('rtg-logo');
          var fired = false;
          var go = function(){ if (fired) return; fired = true; setTimeout(function(){ window.print(); }, 200); };
          if (!img || img.complete) { go(); }
          else { img.addEventListener('load', go); img.addEventListener('error', go); setTimeout(go, 2500); }
        })();
      </script>
      </body></html>`);
    w.document.close();
  };

  // ============== RENDER ==============
  if (sessionStatus === 'loading' || rbacLoading) {
    return (
      <AppLayout title="CAPEX Tracker">
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-500" />
        </div>
      </AppLayout>
    );
  }

  if (!session) return null;

  if (!hasPermission('finance.view_tracker')) {
    return (
      <AppLayout title="CAPEX Tracker">
        <div className="mx-auto max-w-3xl p-6">
          <Card padding="lg">
            <h2 className="mb-2 text-lg font-semibold text-gray-900">Access Restricted</h2>
            <p className="text-gray-600">You do not have permission to view this page.</p>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="CAPEX Tracker">
      <div className="mx-auto max-w-7xl p-4 sm:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CAPEX Tracker</h1>
            <p className="mt-1 text-sm text-gray-500">
              Auto-generated from submitted CAPEX requests. Update funding once an entry is fully approved.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={exportCsv}>
              <svg className="mr-1.5 inline h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
              </svg>
              CSV
            </Button>
            <Button type="button" variant="secondary" onClick={exportExcel}>
              <svg className="mr-1.5 inline h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2a2 2 0 012-2h2a2 2 0 012 2v2M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Excel
            </Button>
            <Button type="button" variant="secondary" onClick={exportPdf}>
              <svg className="mr-1.5 inline h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              PDF
            </Button>
          </div>
        </div>

        {/* Data-visibility banner — what slice of the org this user can see */}
        <ScopeBanner scope={dataScope} />

        {loadError && (
          <Card padding="md" className="border-rose-200 bg-rose-50">
            <div className="flex items-start gap-3">
              <svg className="h-5 w-5 flex-shrink-0 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.19 16a2 2 0 001.74 3z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-rose-800">Couldn&apos;t load CAPEX tracker</p>
                <p className="mt-0.5 text-xs text-rose-700 break-words">{loadError}</p>
              </div>
              <button
                type="button"
                onClick={fetchEntries}
                className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 transition-colors"
              >
                Retry
              </button>
            </div>
          </Card>
        )}

        {/* Filters */}
        <Card padding="md">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-900">Filters</h2>
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700 border border-primary-200">
                  {activeFilterCount} active
                </span>
              )}
              <span className="text-xs text-gray-400">
                · Showing {sortedEntries.length} of {entries.length}
              </span>
            </div>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs font-semibold text-primary-600 hover:text-primary-700 underline-offset-2 hover:underline"
              >
                Reset all
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-600">Search</label>
              <input
                type="text"
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="Supplier, description, champion…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Priority</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={priorityFilter}
                onChange={e => setPriorityFilter(e.target.value)}
              >
                <option value="">All priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Approval stage</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={stageFilter}
                onChange={e => setStageFilter(e.target.value as ApprovalStage)}
              >
                {APPROVAL_STAGE_OPTIONS.map(o => (
                  <option key={o.value || 'all'} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Status</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
              >
                <option value="">All statuses</option>
                {CAPEX_STATUSES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Business unit</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={businessUnitFilter}
                onChange={e => setBusinessUnitFilter(e.target.value)}
              >
                <option value="">
                  {dataScope && !dataScope.isOrgWide ? `All my units (${businessUnits.length})` : 'All business units'}
                </option>
                {businessUnits.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Department</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={departmentFilter}
                onChange={e => setDepartmentFilter(e.target.value)}
              >
                <option value="">All departments</option>
                {departments.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Period</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={periodFilter}
                onChange={e => setPeriodFilter(e.target.value)}
              >
                {PERIOD_OPTIONS.map(o => (
                  <option key={o.value || 'all'} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Financial year</label>
              <select
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={yearFilter}
                onChange={e => setYearFilter(e.target.value)}
              >
                <option value="">All years</option>
                {financialYears.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Cost range</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="Min"
                  value={minCost}
                  onChange={e => setMinCost(e.target.value)}
                />
                <span className="text-gray-400">–</span>
                <input
                  type="number"
                  min={0}
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="Max"
                  value={maxCost}
                  onChange={e => setMaxCost(e.target.value)}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Table */}
        <Card padding="none">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-500" />
            </div>
          ) : sortedEntries.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2a4 4 0 014-4h3M9 17l-3 3m0 0l-3-3m3 3V4m6 13h6m-6-4h6m-6-4h6" />
              </svg>
              <p className="mt-3 text-sm font-medium text-gray-700">
                {entries.length === 0 ? 'No CAPEX entries yet' : 'No entries match your filters'}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {entries.length === 0
                  ? 'Entries appear here automatically when CAPEX requests are submitted.'
                  : 'Adjust or clear your filters to see more results.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#F3EADC] text-[#5E4426]">
                  <tr>
                    {COLUMN_DEFS.map(col => {
                      const active = sortBy === col.key;
                      return (
                        <th
                          key={col.key}
                          className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(col.key)}
                            className={`inline-flex items-center gap-1 transition-colors ${active ? 'text-[#5E4426]' : 'text-[#7C5A33] hover:text-[#5E4426]'}`}
                            title={`Sort by ${col.label}`}
                          >
                            <span>{col.label}</span>
                            <span className={`text-[10px] ${active ? 'opacity-100' : 'opacity-30'}`}>
                              {active && sortDir === 'asc' ? '▲' : active && sortDir === 'desc' ? '▼' : '↕'}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap">
                      Funding
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedEntries.map(entry => {
                    const status = deriveStatusDisplay(entry);
                    const priority = priorityDisplay(entry);
                    const canEdit = canUpdateFunding(entry);
                    return (
                      <tr
                        key={entry.id}
                        className={`hover:bg-gray-50 ${entry.request_id ? 'cursor-pointer' : ''}`}
                        // Clicking a row opens the full request. The "Update
                        // progress" button stops propagation so it still edits.
                        onClick={entry.request_id ? () => router.push(`/requests/${entry.request_id}`) : undefined}
                        title={entry.request_id ? 'Open request' : undefined}
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${priority.cls}`}>
                            {priority.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">{entry.supplier || '—'}</td>
                        <td className="px-4 py-3 text-gray-700 max-w-xs">
                          <div className="line-clamp-2">{entry.description}</div>
                          {(entry.department || entry.business_unit) && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              {[entry.business_unit, entry.department].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-gray-700">{formatDate(entry.capex_date)}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-right font-semibold text-gray-900">
                          {formatMoney(Number(entry.cost))}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-right font-semibold text-amber-700">
                          {formatMoney(Number(entry.balance))}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {entry.champion?.display_name ? (
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                <span className="text-xs font-medium text-primary-700">
                                  {entry.champion.display_name.charAt(0).toUpperCase()}
                                </span>
                              </div>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-gray-900 truncate max-w-[160px]">
                                  {entry.champion.display_name}
                                </div>
                                {entry.champion.email && (
                                  <div className="text-xs text-gray-500 truncate max-w-[160px]">{entry.champion.email}</div>
                                )}
                              </div>
                            </div>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${toneClasses(status.tone)}`}>
                            {status.text}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); openEdit(entry); }}
                              className="rounded-lg border border-primary-300 bg-primary-50 px-2 py-1 text-xs font-semibold text-primary-700 hover:bg-primary-100 transition-colors"
                            >
                              Update progress
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Update funding modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeEdit} />
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-1 text-lg font-bold text-gray-900">Update Funding Progress</h3>
            <p className="mb-4 text-sm text-gray-600">
              {editing.supplier ? `${editing.supplier} · ` : ''}{editing.description}
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Funded amount (max {formatMoney(Number(editing.cost))})
                </label>
                <input
                  type="number"
                  min={0}
                  max={Number(editing.cost)}
                  step="0.01"
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editFunded}
                  onChange={e => setEditFunded(e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-500">
                  Balance will be {formatMoney(Math.max(0, Number(editing.cost) - Number(editFunded || 0)))}
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Status</label>
                <select
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editStatus}
                  onChange={e => setEditStatus(e.target.value as CapexTrackerStatus)}
                >
                  {FUNDING_STATUSES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6 flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={closeEdit} disabled={updatingId !== null}>
                Cancel
              </Button>
              <Button type="button" variant="primary" className="flex-1" onClick={submitEdit} isLoading={updatingId !== null}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
