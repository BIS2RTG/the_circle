import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState, useMemo } from 'react';
import { AppLayout } from '../../components/layout';
import { Button } from '../../components/ui';
import AuditAccessGate from '../../components/audit/AuditAccessGate';
import AuditSectionTabs from '../../components/audit/AuditSectionTabs';
import { formatEventTime } from '../../components/audit/AuditEventExplorer';
import Head from 'next/head';
import { Lock, Mail, Bell } from 'lucide-react';

/**
 * Transactions & Workflows — request-centric audit deep-dive (previously
 * /archive/audit). Shows the complete lifecycle of every request:
 * modifications, approval decisions, and the request's immutable
 * audit_events entries.
 */
export default function AuditTransactionsPage() {
    const { data: session, status } = useSession();
    const router = useRouter();

    // Data State
    const [requests, setRequests] = useState<any[]>([]);
    const [loadingRequests, setLoadingRequests] = useState(true);

    // View State
    const [selectedRequest, setSelectedRequest] = useState<any | null>(null);
    const [auditLogs, setAuditLogs] = useState<any[]>([]);
    const [immutableEvents, setImmutableEvents] = useState<any[]>([]);
    const [deliveries, setDeliveries] = useState<any[]>([]);
    const [deliveryCounts, setDeliveryCounts] = useState<{ emails: number; emailsDelivered: number; inApp: number } | null>(null);
    const [loadingLogs, setLoadingLogs] = useState(false);

    // Filters & Sorting
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'date' | 'title' | 'amount'>('date');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    const [filterStatus, setFilterStatus] = useState<string>('all');

    // Bulk Selection
    const [selectedRequestIds, setSelectedRequestIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (status === 'unauthenticated') router.push('/');
    }, [status, router]);

    // Fetch All Requests
    useEffect(() => {
        async function fetchRequests() {
            if (!session) return;
            try {
                setLoadingRequests(true);
                const response = await fetch('/api/requests?limit=1000&scope=audit');
                if (!response.ok) throw new Error('Failed to fetch');
                const data = await response.json();
                setRequests(data.requests || []);
            } catch (err) {
                console.error(err);
            } finally {
                setLoadingRequests(false);
            }
        }
        if (status === 'authenticated') fetchRequests();
    }, [session, status]);

    // Fetch Detail Logs (legacy trail + immutable events)
    useEffect(() => {
        async function fetchLogs() {
            if (!selectedRequest) return;
            try {
                setLoadingLogs(true);
                const [trailResp, eventsResp, deliveriesResp] = await Promise.all([
                    fetch(`/api/audit?requestId=${selectedRequest.id}`),
                    fetch(`/api/audit/events?requestId=${selectedRequest.id}&pageSize=100`),
                    fetch(`/api/audit/deliveries?requestId=${selectedRequest.id}`),
                ]);
                const trail = await trailResp.json();
                setAuditLogs(trail.logs || []);
                if (eventsResp.ok) {
                    const ev = await eventsResp.json();
                    setImmutableEvents(ev.events || []);
                } else {
                    setImmutableEvents([]);
                }
                if (deliveriesResp.ok) {
                    const d = await deliveriesResp.json();
                    setDeliveries(d.timeline || []);
                    setDeliveryCounts(d.counts || null);
                } else {
                    setDeliveries([]);
                    setDeliveryCounts(null);
                }
            } catch (err) {
                console.error(err);
            } finally {
                setLoadingLogs(false);
            }
        }
        if (selectedRequest) fetchLogs();
        else { setAuditLogs([]); setImmutableEvents([]); setDeliveries([]); setDeliveryCounts(null); }
    }, [selectedRequest]);

    // Filtering & Sorting Logic
    const filteredRequests = useMemo(() => {
        let result = requests.filter(req => {
            const query = searchQuery.toLowerCase();
            const matchesSearch =
                req.title.toLowerCase().includes(query) ||
                req.reference_number?.toLowerCase().includes(query) ||
                req.requester.name.toLowerCase().includes(query);
            const matchesStatus = filterStatus === 'all' || req.status === filterStatus;
            return matchesSearch && matchesStatus;
        });

        return result.sort((a, b) => {
            let diff = 0;
            switch (sortBy) {
                case 'date': diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
                case 'title': diff = a.title.localeCompare(b.title); break;
                case 'amount': diff = (Number(a.amount) || 0) - (Number(b.amount) || 0); break;
            }
            return sortOrder === 'asc' ? diff : -diff;
        });
    }, [requests, searchQuery, sortBy, sortOrder, filterStatus]);

    // Bulk Actions
    const handleSelectAll = () => {
        if (selectedRequestIds.size === filteredRequests.length && filteredRequests.length > 0) {
            setSelectedRequestIds(new Set());
        } else {
            setSelectedRequestIds(new Set(filteredRequests.map(r => r.id)));
        }
    };

    const handleSelectOne = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const newSet = new Set(selectedRequestIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedRequestIds(newSet);
    };

    const downloadCSV = (content: string, filename: string) => {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleBulkExport = () => {
        const selected = requests.filter(r => selectedRequestIds.has(r.id));
        if (!selected.length) return;

        const headers = ['ID', 'Reference', 'Title', 'Status', 'Start Date', 'Amount', 'Currency', 'Requester'];
        const rows = selected.map(r => [
            r.id, r.reference_number, r.title, r.status, new Date(r.created_at).toISOString(),
            r.amount, r.currency, r.requester.name
        ]);

        const csv = [headers.join(','), ...rows.map(row => row.map(c => `"${c}"`).join(','))].join('\n');
        downloadCSV(csv, `audit_bulk_export_${new Date().toISOString().slice(0, 10)}.csv`);
    };

    const handleDetailExport = (type: 'csv' | 'print') => {
        if (type === 'print') {
            window.print();
            return;
        }
        if (!selectedRequest || !auditLogs.length) return;

        const headers = ['Timestamp', 'Type', 'Action', 'Actor', 'Details'];
        const rows = auditLogs.map(log => [
            new Date(log.timestamp).toISOString(),
            log.type,
            log.action,
            log.actor.name,
            log.type === 'modification'
                ? `Field: ${log.details.field} (Old: ${log.details.old} -> New: ${log.details.new})`
                : `Comment: ${log.details.comment}`
        ]);

        const csv = [headers.join(','), ...rows.map(row => row.map(c => `"${c}"`).join(','))].join('\n');
        downloadCSV(csv, `audit_log_${selectedRequest.reference_number}.csv`);
    };

    const formatDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const formatTime = (d: string) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    if (status === 'loading') return <AppLayout title="Transactions & Workflows"><div className="p-10 text-center">Loading...</div></AppLayout>;

    return (
        <AuditAccessGate title="Transactions & Workflows">
        <AppLayout title="Transactions & Workflows">
            <Head>
                <title>Transactions & Workflows | The Circle</title>
                <style>{`
                    @media print {
                        body * { visibility: hidden; }
                        #audit-detail-panel, #audit-detail-panel * { visibility: visible; }
                        #audit-detail-panel { position: absolute; left: 0; top: 0; width: 100%; z-index: 9999; border: none; shadow: none; }
                        .no-print { display: none !important; }
                    }
                `}</style>
            </Head>

            <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden">
                {/* 1. Header Section */}
                <div className="flex-shrink-0 p-6 sm:p-8 bg-gradient-to-br from-brand-50 via-white to-[#FAF6F1]/10 border-b border-gray-200 relative overflow-hidden shadow-sm z-10">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
                        <div className="space-y-2 max-w-2xl">
                            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 font-heading tracking-tight">
                                Transactions & Workflows
                            </h1>
                            <p className="text-lg text-gray-600 leading-relaxed">
                                Complete lifecycle tracking of all requests — modifications, approvals,
                                and the immutable record of every workflow action.
                            </p>
                        </div>

                        {/* Stats Cards */}
                        <div className="flex gap-4">
                            <div className="hidden sm:block px-5 py-3 bg-white/60 backdrop-blur-md rounded-2xl border border-white/50 shadow-sm transition-transform hover:scale-105">
                                <div className="text-xs text-brand-600 font-bold uppercase tracking-wider mb-1">Total Requests</div>
                                <div className="text-2xl font-bold text-gray-900">{requests.length}</div>
                            </div>
                            <div className="hidden sm:block px-5 py-3 bg-white/60 backdrop-blur-md rounded-2xl border border-white/50 shadow-sm transition-transform hover:scale-105">
                                <div className="text-xs text-[#9A7545] font-bold uppercase tracking-wider mb-1">Fully Approved</div>
                                <div className="text-2xl font-bold text-gray-900">{requests.filter(r => r.status === 'approved').length}</div>
                            </div>
                        </div>
                    </div>
                    <div className="relative z-10 mt-4 no-print">
                        <AuditSectionTabs />
                    </div>
                    {/* Background Blobs */}
                    <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-gradient-to-bl from-brand-100/30 to-[#F3EADC]/20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
                </div>

                {/* 2. Main Content Split View */}
                <div className="flex-1 flex overflow-hidden bg-gray-50/50">

                    {/* LEFT PANEL: Request List & Controls */}
                    <div className={`flex flex-col border-r border-gray-200 bg-white transition-all duration-300 w-full lg:w-[400px] xl:w-[450px] ${selectedRequest ? 'hidden lg:flex' : 'flex'}`}>

                        {/* Toolbar */}
                        <div className="p-4 border-b border-gray-100 space-y-3 bg-white">
                            <div className="relative">
                                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                <input
                                    type="text"
                                    placeholder="Search requests..."
                                    className="w-full pl-9 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </div>

                            <div className="flex gap-2">
                                <select
                                    className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 focus:outline-none focus:border-brand-500"
                                    value={filterStatus}
                                    onChange={(e) => setFilterStatus(e.target.value)}
                                >
                                    <option value="all">All Statuses</option>
                                    <option value="approved">Approved</option>
                                    <option value="pending">Pending</option>
                                    <option value="rejected">Rejected</option>
                                </select>
                                <select
                                    className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 focus:outline-none focus:border-brand-500"
                                    value={sortBy}
                                    onChange={(e) => setSortBy(e.target.value as any)}
                                >
                                    <option value="date">Sort: Date</option>
                                    <option value="title">Sort: Title</option>
                                    <option value="amount">Sort: Amount</option>
                                </select>
                                <button
                                    onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
                                    className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 hover:text-gray-900 transition-colors"
                                    title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
                                >
                                    <svg className={`w-4 h-4 transform transition-transform ${sortOrder === 'asc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                                    </svg>
                                </button>
                            </div>

                            {/* Bulk Action Header */}
                            {selectedRequestIds.size > 0 ? (
                                <div className="flex items-center justify-between bg-brand-50 px-3 py-2 rounded-lg border border-brand-100 animate-fadeIn">
                                    <span className="text-xs font-bold text-brand-700">{selectedRequestIds.size} selected</span>
                                    <button onClick={handleBulkExport} className="text-xs font-medium text-brand-600 hover:text-brand-800 flex items-center gap-1">
                                        Export CSV
                                    </button>
                                </div>
                            ) : (
                                <div className="px-1 flex items-center justify-between text-xs text-gray-400 font-medium uppercase tracking-wider">
                                    <span>Requests List</span>
                                    <span>{filteredRequests.length} Found</span>
                                </div>
                            )}
                        </div>

                        {/* Scrolling List */}
                        <div className="flex-1 overflow-y-auto">
                            {loadingRequests ? (
                                <div className="p-10 text-center text-gray-400 text-sm">Loading requests...</div>
                            ) : filteredRequests.length === 0 ? (
                                <div className="p-10 text-center text-gray-400 text-sm">No matches found.</div>
                            ) : (
                                <div className="divide-y divide-gray-50">
                                    {/* Select All Row */}
                                    <div className="px-4 py-2 bg-gray-50/50 flex items-center gap-3 border-b border-gray-50">
                                        <input
                                            type="checkbox"
                                            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                                            checked={selectedRequestIds.size === filteredRequests.length && filteredRequests.length > 0}
                                            onChange={handleSelectAll}
                                        />
                                        <span className="text-xs font-semibold text-gray-500">Select All</span>
                                    </div>

                                    {filteredRequests.map(req => (
                                        <div
                                            key={req.id}
                                            onClick={() => setSelectedRequest(req)}
                                            className={`group px-4 py-4 cursor-pointer hover:bg-gray-50 transition-colors border-l-4 relative
                                                ${selectedRequest?.id === req.id
                                                    ? 'bg-[#F3EADC]/50 border-brand-500'
                                                    : 'border-transparent'}`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <div onClick={e => handleSelectOne(req.id, e)} className="pt-1">
                                                    <input
                                                        type="checkbox"
                                                        className="rounded border-gray-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                                                        checked={selectedRequestIds.has(req.id)}
                                                        onChange={() => { }}
                                                    />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex justify-between items-start mb-1">
                                                        <h3 className={`text-sm font-semibold truncate ${selectedRequest?.id === req.id ? 'text-brand-700' : 'text-gray-900'}`}>{req.title}</h3>
                                                        <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${req.status === 'approved' ? 'bg-green-100 text-green-700' :
                                                                req.status === 'rejected' ? 'bg-red-100 text-red-700' :
                                                                    'bg-yellow-100 text-yellow-700'
                                                            }`}>{req.status}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                                                        <span className="font-mono">{req.reference_number}</span>
                                                        <span>•</span>
                                                        <span>{formatDate(req.created_at)}</span>
                                                    </div>
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-2">
                                                            {req.requester.avatar ? (
                                                                <img src={req.requester.avatar} alt={`${req.requester.name || 'Requester'} avatar`} className="w-5 h-5 rounded-full bg-gray-200" />
                                                            ) : (
                                                                <div className="w-5 h-5 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center text-[9px] font-bold">
                                                                    {req.requester.name.charAt(0)}
                                                                </div>
                                                            )}
                                                            <span className="text-xs text-gray-600">{req.requester.name}</span>
                                                        </div>
                                                        <span className="text-xs font-mono font-medium text-gray-900">{req.currency} {Number(req.amount).toLocaleString()}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* RIGHT PANEL: Details */}
                    {selectedRequest ? (
                        <div id="audit-detail-panel" className="flex-1 flex flex-col bg-gray-50/50 h-full overflow-hidden w-full">
                            {/* Scrollable Container */}
                            <div className="overflow-y-auto flex-1 p-4 md:p-8">
                                <div className="max-w-4xl mx-auto space-y-6">

                                    {/* Navigation (Mobile Only) */}
                                    <button
                                        onClick={() => setSelectedRequest(null)}
                                        className="lg:hidden flex items-center gap-2 text-gray-500 mb-4 font-medium"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" /></svg>
                                        Back to List
                                    </button>

                                    {/* Detail Card */}
                                    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                                        {/* Card Header */}
                                        <div className="px-6 py-6 border-b border-gray-100 flex flex-col md:flex-row justify-between items-start gap-4">
                                            <div>
                                                <div className="flex items-center gap-3 mb-2">
                                                    <span className="px-2 py-1 rounded-md bg-gray-100 text-gray-600 font-mono text-xs tracking-wide">
                                                        {selectedRequest.reference_number}
                                                    </span>
                                                    <span className="text-sm text-gray-400">{formatDate(selectedRequest.created_at)}</span>
                                                </div>
                                                <h2 className="text-2xl font-bold text-gray-900">{selectedRequest.title}</h2>
                                            </div>
                                            <div className="flex gap-2 no-print">
                                                <Button size="sm" variant="outline" onClick={() => handleDetailExport('csv')}>
                                                    Export CSV
                                                </Button>
                                                <Button size="sm" variant="outline" onClick={() => handleDetailExport('print')}>
                                                    Print
                                                </Button>
                                                <Button size="sm" variant="secondary" onClick={() => router.push(`/requests/${selectedRequest.id}`)}>
                                                    Open Request
                                                </Button>
                                            </div>
                                        </div>

                                        {/* Card Stats */}
                                        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-gray-100 bg-gray-50/30">
                                            <div className="p-5 flex items-center gap-4">
                                                <div className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center shadow-sm">
                                                    <span className="text-lg">👤</span>
                                                </div>
                                                <div>
                                                    <div className="text-xs text-gray-500 uppercase font-bold tracking-wider">Requester</div>
                                                    <div className="font-semibold text-gray-900">{selectedRequest.requester.name}</div>
                                                    <div className="text-xs text-gray-500">{selectedRequest.requester.email}</div>
                                                </div>
                                            </div>
                                            <div className="p-5 flex items-center gap-4">
                                                <div className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center shadow-sm">
                                                    <span className="text-lg">💰</span>
                                                </div>
                                                <div>
                                                    <div className="text-xs text-gray-500 uppercase font-bold tracking-wider">Amount</div>
                                                    <div className="font-semibold text-gray-900">{selectedRequest.currency} {Number(selectedRequest.amount).toLocaleString()}</div>
                                                    <div className="text-xs text-gray-500">Total Value</div>
                                                </div>
                                            </div>
                                            <div className="p-5 flex items-center gap-4">
                                                <div className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center shadow-sm">
                                                    <span className="text-lg">📊</span>
                                                </div>
                                                <div>
                                                    <div className="text-xs text-gray-500 uppercase font-bold tracking-wider">Current Status</div>
                                                    <div className={`font-semibold capitalize ${selectedRequest.status === 'approved' ? 'text-green-600' :
                                                            selectedRequest.status === 'rejected' ? 'text-red-600' : 'text-yellow-600'
                                                        }`}>{selectedRequest.status}</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Timeline Section */}
                                    <div className="relative">
                                        <div className="absolute top-0 bottom-0 left-6 w-0.5 bg-gray-200"></div>

                                        <div className="space-y-8">
                                            {/* Start Node */}
                                            <div className="relative pl-16">
                                                <div className="absolute left-3 top-0 w-6 h-6 rounded-full bg-green-100 border-4 border-white shadow-sm flex items-center justify-center z-10">
                                                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                                </div>
                                                <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <h4 className="font-bold text-gray-900">Request Created</h4>
                                                        <span className="text-xs text-gray-400 font-mono">{formatTime(selectedRequest.created_at)}</span>
                                                    </div>
                                                    <p className="text-sm text-gray-600">Request initially submitted by {selectedRequest.requester.name}.</p>
                                                </div>
                                            </div>

                                            {/* Dynamic Logs */}
                                            {loadingLogs ? (
                                                <div className="pl-16 text-gray-400 text-sm">Loading audit history...</div>
                                            ) : auditLogs.map((log) => (
                                                <div key={log.id} className="relative pl-16 group">
                                                    <div className={`absolute left-3 top-0 w-6 h-6 rounded-full border-4 border-white shadow-sm flex items-center justify-center z-10
                                                        ${log.type === 'approval'
                                                            ? (log.action.toLowerCase().includes('approved') ? 'bg-green-100' : 'bg-red-100')
                                                            : 'bg-[#F3EADC]'
                                                        }`}>
                                                        <div className={`w-2 h-2 rounded-full
                                                            ${log.type === 'approval'
                                                                ? (log.action.toLowerCase().includes('approved') ? 'bg-green-500' : 'bg-red-500')
                                                                : 'bg-[#9A7545]'
                                                            }`}></div>
                                                    </div>

                                                    <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-bold text-gray-900">{log.action}</span>
                                                                {log.actor && (
                                                                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">by {log.actor.name}</span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2 text-xs text-gray-400 font-mono">
                                                                <span>{formatDate(log.timestamp)}</span>
                                                                <span>{formatTime(log.timestamp)}</span>
                                                            </div>
                                                        </div>

                                                        {log.type === 'modification' ? (
                                                            <div className="text-sm bg-gray-50 rounded-lg p-3 border border-gray-100">
                                                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                                                    Modified Field: <span className="text-gray-900">{log.details.field}</span>
                                                                </div>
                                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                                    <div>
                                                                        <span className="block text-[10px] text-gray-400 mb-0.5">PREVIOUS VALUE</span>
                                                                        <div className="text-red-600 bg-red-50 px-2 py-1 rounded text-xs line-through opacity-70 break-all border border-red-100">
                                                                            {log.details.old || '(empty)'}
                                                                        </div>
                                                                    </div>
                                                                    <div>
                                                                        <span className="block text-[10px] text-gray-400 mb-0.5">NEW VALUE</span>
                                                                        <div className="text-green-700 bg-green-50 px-2 py-1 rounded text-xs font-medium break-all border border-green-100">
                                                                            {log.details.new || '(empty)'}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="text-sm text-gray-700 italic border-l-2 border-gray-300 pl-3">
                                                                &ldquo;{log.details.comment || 'No comment provided.'}&rdquo;
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Notifications & emails sent for this request */}
                                    {!loadingLogs && (deliveries.length > 0 || deliveryCounts) && (
                                        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                                            <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center gap-2">
                                                <Bell className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
                                                <h3 className="font-bold text-gray-900 text-sm">Notifications &amp; Emails</h3>
                                                {deliveryCounts && (
                                                    <span className="text-xs text-gray-400">
                                                        — {deliveryCounts.inApp} in-app · {deliveryCounts.emailsDelivered}/{deliveryCounts.emails} emails delivered
                                                    </span>
                                                )}
                                            </div>
                                            {deliveries.length === 0 ? (
                                                <div className="px-5 py-4 text-sm text-gray-400">No notifications recorded for this request.</div>
                                            ) : (
                                                <div className="divide-y divide-gray-50">
                                                    {deliveries.map((d: any) => (
                                                        <div key={`${d.channel}-${d.id}`} className="px-5 py-3 flex items-center gap-3 text-sm">
                                                            {d.channel === 'email' ? (
                                                                <Mail className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.5} />
                                                            ) : (
                                                                <Bell className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.5} />
                                                            )}
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-medium text-gray-900 truncate">{d.subject || '(no subject)'}</div>
                                                                <div className="text-xs text-gray-500 truncate">
                                                                    {d.channel === 'email' ? 'Email' : 'In-app'} to {d.recipientName}
                                                                    {d.kind ? ` · ${d.kind}` : ''}
                                                                    {d.channel === 'email' && d.reason && !d.success ? ` · ${d.reason}` : ''}
                                                                    {d.channel === 'in_app' && d.onBehalfOf ? ' · assistant copy' : ''}
                                                                </div>
                                                            </div>
                                                            <span className="text-xs text-gray-400 font-mono whitespace-nowrap">{formatEventTime(d.at)}</span>
                                                            {d.channel === 'email' ? (
                                                                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${d.success ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                                                                    {d.success ? 'Sent' : 'Not sent'}
                                                                </span>
                                                            ) : (
                                                                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${d.isRead ? 'bg-gray-100 text-gray-500' : 'bg-brand-50 text-brand-600'}`}>
                                                                    {d.isRead ? 'Read' : 'Unread'}
                                                                </span>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Immutable event records for this request */}
                                    {!loadingLogs && immutableEvents.length > 0 && (
                                        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                                            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
                                                <Lock className="w-4 h-4 text-emerald-600" strokeWidth={1.5} />
                                                <h3 className="font-bold text-gray-900 text-sm">Immutable Audit Entries</h3>
                                                <span className="text-xs text-gray-400">— sealed in the SHA-256 hash chain</span>
                                            </div>
                                            <div className="divide-y divide-gray-50">
                                                {immutableEvents.map((e: any) => (
                                                    <div key={e.id} className="px-5 py-3 flex items-center gap-3 text-sm">
                                                        <span className="font-mono text-[10px] text-gray-400 w-10 shrink-0">#{e.sequence_number}</span>
                                                        <span className="font-medium text-gray-900 flex-1 truncate">{e.action}</span>
                                                        <span className="text-xs text-gray-500 truncate max-w-[120px]">{e.actor_name || 'System'}</span>
                                                        <span className="text-xs text-gray-400 font-mono whitespace-nowrap">{formatEventTime(e.occurred_at)}</span>
                                                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${e.outcome === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                                                            {e.outcome}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        /* Empty State (Tablet/Desktop) */
                        <div className="hidden lg:flex flex-1 items-center justify-center bg-gray-50 flex-col text-center p-8">
                            <div className="w-24 h-24 bg-white rounded-full shadow-sm flex items-center justify-center mb-6">
                                <svg className="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">Select a request to view details</h3>
                            <p className="text-gray-500 mt-2 max-w-sm">
                                Click on any request from the list to view its complete audit trail, approvals, and modification history.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </AppLayout>
        </AuditAccessGate>
    );
}
