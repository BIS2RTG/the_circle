import { useMemo, useRef, type ReactNode } from 'react';
import { RequestPreviewModal, RequestPreviewDocument, printPreviewDocument } from '../ui';
import type { PreviewSection, DocumentHeader } from '../ui';
import {
    buildTravelAuthPreviewSections,
    buildTravelAuthDocumentHeader,
    travelAuthInputFromRequest,
} from '../../lib/previews/travelAuthPreview';
import {
    buildCapexPreviewSections,
    capexPreviewTitle,
    capexPreviewDocumentHeader,
} from '../../lib/previews/capexPreview';
import { CAPEX_APPROVAL_ROLES } from '../../lib/capexApproval';

/**
 * ApprovedRequestPreview
 * ----------------------
 * Renders a fully-approved request inside the same RequestPreviewModal layout
 * that the form pages use for their submission preview. The goal is parity:
 * once a request is signed off, the requester (and watchers) can open exactly
 * the same document they previewed before submitting — now annotated with the
 * approval signatures captured by each step.
 *
 * The component dispatches on `request.metadata.type` and emits a section list
 * tailored to each request type. Unknown types fall back to a generic
 * key/value renderer so the modal is always populated with something readable.
 *
 * Heavy-lifting form-specific JSX has been kept lightweight; pixel-perfect
 * parity with the original form pages would require sharing the exact JSX
 * (large) — this renderer instead reproduces the same document-grid styling
 * and the data that actually appears on the printed/exported page.
 */

interface Props {
    isOpen: boolean;
    onClose: () => void;
    request: any;
}

interface InlineProps {
    request: any;
    /** Optional className applied to the outer wrapper of the inline preview. */
    className?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Inline doc-grid styles — match the originals in RequestPreviewModal so
// the modal's print/save-as-PDF picks up the same look.
// ──────────────────────────────────────────────────────────────────────
const docGridStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const cellStyle: React.CSSProperties = { border: '1px solid #333', padding: '6px 8px', verticalAlign: 'top' };
const labelCellStyle: React.CSSProperties = { ...cellStyle, fontWeight: 600, color: '#333', background: '#F3EADC', width: '22%' };
const headCellStyle: React.CSSProperties = { ...cellStyle, background: '#F3EADC', color: '#5E4426', fontWeight: 700, textAlign: 'left' };

function formatDate(value: any): string {
    if (!value) return '—';
    const s = String(value);
    // Accept ISO or already-formatted strings; only re-format ISO-ish dates.
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        try {
            return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        } catch {
            return s;
        }
    }
    return s;
}

function formatDateTime(value: any): string {
    if (!value) return '—';
    try {
        return new Date(value).toLocaleString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return String(value);
    }
}

function money(value: any, currency = 'USD'): string {
    if (value == null || value === '') return '—';
    const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) return String(value);
    return `${currency} ${n.toFixed(2)}`;
}

function humaniseKey(key: string): string {
    return key
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .replace(/^./, c => c.toUpperCase())
        .trim();
}

// ──────────────────────────────────────────────────────────────────────
// Approval signatures table — common to every request type. The PDF
// archive includes signature images; here we render the audit row so the
// requester sees who approved, when, and with what authentication.
// ──────────────────────────────────────────────────────────────────────
// Build the public signature URL for a given approver, falling back to null
// when we can't compose one (e.g. missing env var). We deliberately compose
// the URL on the client rather than waiting for the API to enrich the
// approval row — that way the signature appears the moment a refreshed
// `request_steps` payload lands, no extra round-trip required.
function savedSignatureUrlForApprover(approverId?: string | null): string | null {
    if (!approverId) return null;
    // Private bucket: render the saved signature through the authenticated proxy.
    return `/api/signature/view?userId=${encodeURIComponent(approverId)}`;
}

// Resolve the signature image to render for an approval. A signature that was
// freshly DRAWN at approval time is uploaded to a per-request path and stored
// on the approval row (signature_url / signature_reference) — that takes
// precedence. Only when no per-approval signature was recorded do we fall back
// to the approver's pre-registered (saved) signature image.
function signatureUrlForApproval(approval: any, approverId?: string | null): string | null {
    const drawn = approval?.signature_url || approval?.signature_reference;
    if (typeof drawn === 'string' && drawn) return drawn;
    return savedSignatureUrlForApprover(approverId);
}

function buildApprovalSignaturesSection(request: any): PreviewSection {
    const steps = Array.isArray(request?.request_steps) ? [...request.request_steps] : [];
    steps.sort((a: any, b: any) => (a.step_index ?? 0) - (b.step_index ?? 0));

    return {
        title: 'Approval Signatures',
        content: (
            <table style={docGridStyle}>
                <thead>
                    <tr>
                        <th style={{ ...headCellStyle, width: '8%' }}>Step</th>
                        <th style={headCellStyle}>Role</th>
                        <th style={headCellStyle}>Approver</th>
                        <th style={{ ...headCellStyle, width: '18%' }}>Signature</th>
                        <th style={headCellStyle}>Decision</th>
                        <th style={headCellStyle}>Signed At</th>
                        <th style={headCellStyle}>Verification</th>
                        <th style={headCellStyle}>Comment</th>
                    </tr>
                </thead>
                <tbody>
                    {steps.length === 0 ? (
                        <tr><td style={cellStyle} colSpan={8}>No approval steps recorded.</td></tr>
                    ) : (
                        steps.map((step: any, i: number) => {
                            const approval = Array.isArray(step.approvals) ? step.approvals[0] : null;
                            const approverName = step.approver?.display_name || approval?.approver?.display_name || '—';
                            const role = step.approver_role || step.step_definition?.name || `Step ${i + 1}`;
                            const decision = approval?.decision
                                ? approval.decision.charAt(0).toUpperCase() + approval.decision.slice(1)
                                : '—';
                            const auth = approval?.authentication_method;
                            const verification =
                                auth === 'biometric' ? 'Biometric (WebAuthn)' :
                                auth === 'microsoft_mfa' ? 'Microsoft MFA' :
                                auth === 'session' ? 'Session' :
                                approval?.signed_at ? 'Recorded' : '—';
                            const approverId = approval?.approver?.id || approval?.approver_id || step.approver?.id;
                            const sigUrl = approval?.signed_at ? signatureUrlForApproval(approval, approverId) : null;
                            return (
                                <tr key={step.id || i}>
                                    <td style={cellStyle}>{i + 1}</td>
                                    <td style={cellStyle}>{String(role).replace(/_/g, ' ')}</td>
                                    <td style={cellStyle}>{approverName}</td>
                                    <td style={cellStyle}>
                                        {sigUrl ? (
                                            <img
                                                src={sigUrl}
                                                alt={`${approverName} signature`}
                                                style={{ maxHeight: 48, maxWidth: '100%', display: 'block' }}
                                                onError={(e) => {
                                                    // If the file isn't uploaded for this user, hide the broken-image icon.
                                                    (e.target as HTMLImageElement).style.display = 'none';
                                                }}
                                            />
                                        ) : (
                                            <span style={{ color: '#9ca3af', fontSize: 11 }}>—</span>
                                        )}
                                    </td>
                                    <td style={{
                                        ...cellStyle,
                                        color: approval?.decision === 'approved' ? '#15803d'
                                            : approval?.decision === 'rejected' ? '#b91c1c' : '#374151',
                                        fontWeight: 600,
                                    }}>{decision}</td>
                                    <td style={cellStyle}>{approval?.signed_at ? formatDateTime(approval.signed_at) : '—'}</td>
                                    <td style={cellStyle}>{verification}</td>
                                    <td style={cellStyle}>{approval?.comment || '—'}</td>
                                </tr>
                            );
                        })
                    )}
                </tbody>
            </table>
        ),
    };
}

// ──────────────────────────────────────────────────────────────────────
// Type-specific sections.
// ──────────────────────────────────────────────────────────────────────
function buildTravelAuthSections(request: any, metadata: any): PreviewSection[] {
    const creator = request.creator || {};
    const itinerary: any[] = Array.isArray(metadata.itinerary) ? metadata.itinerary : [];
    const budget = metadata.budget || {};
    const totalKm = itinerary.reduce((sum, r) => sum + (parseFloat(r?.km) || 0), 0);

    return [
        {
            content: (
                <table style={docGridStyle}>
                    <tbody>
                        <tr>
                            <td style={labelCellStyle}>Name of Employee</td>
                            <td style={cellStyle}>{creator.display_name || '—'}</td>
                            <td style={labelCellStyle}>Department</td>
                            <td style={cellStyle}>{metadata.department || creator.department?.name || '—'}</td>
                        </tr>
                        <tr>
                            <td style={labelCellStyle}>Business Unit</td>
                            <td style={cellStyle}>{metadata.businessUnit || metadata.business_unit_name || creator.business_unit?.name || '—'}</td>
                            <td style={labelCellStyle}>Submitted</td>
                            <td style={cellStyle}>{formatDateTime(request.created_at)}</td>
                        </tr>
                        <tr>
                            <td style={labelCellStyle}>Date of Intended Travel</td>
                            <td style={cellStyle} colSpan={3}>{formatDate(metadata.dateOfIntendedTravel)}</td>
                        </tr>
                        <tr>
                            <td style={labelCellStyle}>Purpose of Travel</td>
                            <td style={cellStyle} colSpan={3}>{metadata.purposeOfTravel || '—'}</td>
                        </tr>
                        <tr>
                            <td style={labelCellStyle}>Accompanying Associates</td>
                            <td style={cellStyle} colSpan={3}>{metadata.accompanyingAssociates || '—'}</td>
                        </tr>
                        <tr>
                            <td style={labelCellStyle}>Travel Mode</td>
                            <td style={cellStyle} colSpan={3}>{metadata.travelMode || '—'}</td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
        {
            title: 'Travel Itinerary',
            content: (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={headCellStyle}>Date / Time</th>
                            <th style={headCellStyle}>From</th>
                            <th style={headCellStyle}>To</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Distance (km)</th>
                            <th style={headCellStyle}>Justification</th>
                        </tr>
                    </thead>
                    <tbody>
                        {itinerary.length === 0 ? (
                            <tr><td style={cellStyle} colSpan={5}>No itinerary entries.</td></tr>
                        ) : itinerary.map((it: any, i: number) => (
                            <tr key={i}>
                                <td style={cellStyle}>{it.date || '—'}</td>
                                <td style={cellStyle}>{it.from || '—'}</td>
                                <td style={cellStyle}>{it.to || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{it.km || '—'}</td>
                                <td style={cellStyle}>{it.justification || '—'}</td>
                            </tr>
                        ))}
                        <tr>
                            <td style={{ ...cellStyle, fontWeight: 700 }} colSpan={3}>Total Distance</td>
                            <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 700 }}>{totalKm.toFixed(1)}</td>
                            <td style={cellStyle}></td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
        {
            title: 'Travel Budget',
            content: (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={headCellStyle}>Item</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Quantity</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Unit Cost (USD)</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Total (USD)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[
                            ['Fuel', budget.fuel],
                            ['AA Rates (Personal Vehicle)', budget.aaRates],
                            ['Air / Bus Tickets', budget.airBusTickets],
                            ['Overnight Accommodation (b&b)', budget.bnb || budget.accommodation],
                            ['Lunch / Dinner', budget.lunchDinner],
                            ['Conferencing Cost', budget.conferencingCost],
                        ]
                            .filter(([, data]) => data && (data.quantity || data.unitCost || data.totalCost))
                            .map(([label, data], i) => (
                                <tr key={i}>
                                    <td style={cellStyle}>{label}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{data.quantity || '—'}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{data.unitCost || '—'}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{data.totalCost || '0.00'}</td>
                                </tr>
                            ))}
                        {Array.isArray(budget.tollgates) && budget.tollgates.map((t: any, i: number) => (
                            <tr key={`t-${i}`}>
                                <td style={cellStyle}>Tollgate{t.road ? ` — ${t.road}` : ''}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{t.quantity || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{t.unitCost || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{t.totalCost || '0.00'}</td>
                            </tr>
                        ))}
                        {/* Miscellaneous costs — current multi-line list plus legacy single "other". */}
                        {(Array.isArray(budget.miscCosts)
                            ? budget.miscCosts
                            : (budget.other && (budget.other.quantity || budget.other.totalCost) ? [budget.other] : [])
                        ).map((m: any, i: number) => (
                            <tr key={`misc-${i}`}>
                                <td style={cellStyle}>{m.description ? m.description : 'Miscellaneous'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{m.quantity || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{m.unitCost || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{m.totalCost || '0.00'}</td>
                            </tr>
                        ))}
                        <tr>
                            <td style={{ ...cellStyle, fontWeight: 700, background: '#F3EADC' }} colSpan={3}>GRAND TOTAL</td>
                            <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 700, background: '#F3EADC' }}>
                                {money(metadata.grandTotal, 'USD')}
                            </td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
    ];
}

function buildPettyCashSections(request: any, metadata: any): PreviewSection[] {
    const lineItems: any[] = Array.isArray(metadata.lineItems) ? metadata.lineItems : [];
    const total = lineItems.reduce((sum, r) => sum + (parseFloat(r?.amount) || 0), 0);
    const creator = request?.creator || {};
    const supportingDocs: any[] = Array.isArray(metadata.supportingDocuments) ? metadata.supportingDocuments : [];

    // Recipient signature stored as { type: 'manual', data: <data URL> } —
    // surface the data URL directly as an <img> so it appears on the preview
    // exactly as drawn on the form.
    const recipientSig = metadata.receivedBy?.signature;
    const recipientSigData =
        typeof recipientSig === 'string'
            ? recipientSig
            : recipientSig?.data || recipientSig?.dataUrl || null;

    // Build the recipient section. We always show name/date/isExternal, plus
    // ID + signature for external recipients (matches the form's UX).
    const recipientFields: any[] = [
        { label: 'Received by', value: metadata.receivedBy?.name || '—' },
        { label: 'Date', value: formatDate(metadata.receivedBy?.date) },
        { label: 'External Recipient', value: metadata.receivedBy?.isExternal ? 'Yes' : 'No' },
    ];
    if (metadata.receivedBy?.isExternal) {
        recipientFields.push({ label: 'ID No.', value: metadata.receivedBy?.externalIdNumber || '—' });
        if (recipientSigData) {
            recipientFields.push({
                label: 'Recipient Signature',
                fullWidth: true,
                value: (
                    <img
                        src={recipientSigData}
                        alt="Recipient signature"
                        style={{ maxHeight: 80, maxWidth: 300, display: 'block', background: '#fff', border: '1px solid #e5e7eb', padding: 4, borderRadius: 4 }}
                    />
                ),
            });
        }
    }

    return [
        // Request header — gives approvers everything they need to identify
        // the request at a glance without opening the linked travel auth.
        {
            title: 'Request',
            fields: [
                { label: 'Receipt Date', value: formatDate(metadata.receiptDate) },
                { label: 'Reference Code', value: metadata.referenceCode || '—' },
                { label: 'Currency', value: metadata.currency || 'USD' },
                { label: 'Purpose', value: metadata.purpose || '—', fullWidth: true },
                {
                    label: 'Linked Travel Authorization',
                    value: metadata.linkedTravelAuth?.referenceCode
                        || metadata.linkedTravelAuth?.title
                        || (metadata.linkedTravelAuthId ? metadata.linkedTravelAuthId : 'None'),
                    fullWidth: true,
                },
            ],
        },
        // Requestor info — required for finance / accountant approvers who
        // need to know whose float this is and which department to bill.
        {
            title: 'Requestor',
            fields: [
                { label: 'Submitted by', value: creator.display_name || '—' },
                { label: 'Email', value: creator.email || '—' },
                { label: 'Department', value: metadata.department || creator.department?.name || '—' },
                { label: 'Business Unit', value: metadata.businessUnit || metadata.business_unit_name || creator.business_unit?.name || '—' },
                { label: 'Submitted', value: formatDateTime(request?.created_at) },
            ],
        },
        {
            title: 'Line Items',
            content: (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={headCellStyle}>Description</th>
                            <th style={{ ...headCellStyle, textAlign: 'right', width: '18%' }}>Amount (USD)</th>
                            <th style={{ ...headCellStyle, width: '25%' }}>Charge To</th>
                        </tr>
                    </thead>
                    <tbody>
                        {lineItems.filter((r: any) => r.description || r.amount || r.chargeTo).map((r: any, i: number) => (
                            <tr key={i}>
                                <td style={cellStyle}>{r.description || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{money(r.amount, 'USD')}</td>
                                <td style={cellStyle}>{r.chargeTo || '—'}</td>
                            </tr>
                        ))}
                        <tr>
                            <td style={{ ...cellStyle, fontWeight: 700, background: '#F3EADC' }}>TOTAL</td>
                            <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 700, background: '#F3EADC' }}>
                                {money(metadata.totalAmount ?? total, 'USD')}
                            </td>
                            <td style={{ ...cellStyle, background: '#F3EADC' }}></td>
                        </tr>
                    </tbody>
                </table>
            ),
        },
        {
            title: 'Recipient',
            fields: recipientFields,
        },
        ...(supportingDocs.length > 0 ? [{
            title: 'Supporting Documents',
            content: (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={{ ...headCellStyle, width: '8%' }}>#</th>
                            <th style={headCellStyle}>Label</th>
                            <th style={headCellStyle}>Description</th>
                            <th style={headCellStyle}>File</th>
                        </tr>
                    </thead>
                    <tbody>
                        {supportingDocs.map((d: any, i: number) => (
                            <tr key={i}>
                                <td style={cellStyle}>{i + 1}</td>
                                <td style={cellStyle}>{d.label || '—'}</td>
                                <td style={cellStyle}>{d.description || '—'}</td>
                                <td style={cellStyle}>{d.name || d.filename || '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ),
        }] : []),
        ...(Array.isArray(metadata.linkedApprovedRequests) && metadata.linkedApprovedRequests.length > 0 ? [{
            title: 'Linked Approved Requests',
            content: (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={{ ...headCellStyle, width: '20%' }}>Reference</th>
                            <th style={{ ...headCellStyle, width: '20%' }}>Type</th>
                            <th style={headCellStyle}>Title</th>
                            <th style={{ ...headCellStyle, width: '18%' }}>Approved</th>
                        </tr>
                    </thead>
                    <tbody>
                        {metadata.linkedApprovedRequests.map((l: any, i: number) => (
                            <tr key={l.id || i}>
                                <td style={{ ...cellStyle, fontFamily: 'monospace', fontWeight: 600 }}>
                                    {l.referenceCode || l.id?.substring(0, 8) || '—'}
                                </td>
                                <td style={cellStyle}>{String(l.requestType || '').replace(/_/g, ' ') || '—'}</td>
                                <td style={cellStyle}>{l.title || '—'}</td>
                                <td style={cellStyle}>{l.approvedAt ? formatDate(l.approvedAt) : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ),
        }] : []),
    ];
}

// ──────────────────────────────────────────────────────────────────────
// Complimentary / hotel-booking sections. The comp/[id] page handles
// three request types interchangeably (voucher_request, hotel_booking,
// external_hotel_booking) — they all share the same metadata shape
// (guest info + selectedBusinessUnits[] + optional travelDocument), so
// we use a single builder.
// ──────────────────────────────────────────────────────────────────────
const COMP_ALLOCATION_LABELS: Record<string, string> = {
    marketing_domestic: 'Marketing – Domestic',
    marketing_international: 'Marketing – International',
    administration: 'Administration',
    promotions: 'Promotions',
    personnel: 'Personnel',
};

const COMP_ACCOMMODATION_LABELS: Record<string, string> = {
    accommodation_only: 'Accommodation Only (Bed only)',
    accommodation_and_breakfast: 'Bed & Breakfast',
    accommodation_and_meals: 'Accommodation & Meals',
    accommodation_meals_drink: 'Accommodation, Meals & Soft Drink',
    meals_all: 'Meals (Breakfast, Lunch and Dinner)',
    rainbow_delights: 'Rainbow Delights Meal',
    breakfast_only: 'Breakfast only',
    lunch_only: 'Lunch only',
    dinner_only: 'Dinner only',
};

function buildCompSections(request: any, metadata: any): PreviewSection[] {
    const creator = request?.creator || {};
    const travel = metadata.travelDocument;
    const hasTravel = metadata.processTravelDocument && travel;

    // Normalise units: the multi-unit picker stores selectedBusinessUnits[];
    // external hotel bookings store a single flat hotelUnit + room fields. The
    // projection keeps the original table populated for both shapes.
    const units: any[] = (() => {
        if (Array.isArray(metadata.selectedBusinessUnits) && metadata.selectedBusinessUnits.length > 0) {
            return metadata.selectedBusinessUnits;
        }
        if (metadata.hotelUnit || metadata.numberOfRooms || metadata.numberOfNights || metadata.arrivalDate) {
            return [{
                name: metadata.hotelUnit || 'Hotel',
                accommodationType: metadata.accommodationType,
                voucherValidityPeriod: metadata.voucherValidityPeriod
                    || (metadata.arrivalDate && metadata.departureDate ? `${metadata.arrivalDate} → ${metadata.departureDate}` : ''),
                numberOfPeople: metadata.numberOfPeople,
                numberOfRooms: metadata.numberOfNights || metadata.numberOfRooms,
                roomType: metadata.roomType,
                numberOfMeals: metadata.numberOfMeals,
                mealPeopleCount: metadata.mealPeopleCount,
                specialArrangements: metadata.specialArrangements,
            }];
        }
        return [];
    })();

    const isMealOnly = (t?: string) => ['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only'].includes(t || '');

    // A comp requester is usually the guest themselves — fall back to the
    // requestor's name when no explicit guest was entered.
    const guestDisplay = metadata.guestNames
        || [metadata.guestTitle, metadata.guestFirstName].filter(Boolean).join(' ')
        || creator.display_name
        || '—';

    // Hotel bookings store stay dates + nights; vouchers store a validity
    // period + people + room type. Render the columns the data actually
    // carries so populated fields don't show as '—'.
    const hasStayDates = units.some((u: any) => u.arrivalDate || u.departureDate);

    // A comp requester is usually the guest themselves — only surface the
    // "Requestor" (Submitted by) block when the request was filed on behalf of
    // someone else, so it doesn't duplicate the guest information.
    const onBehalf = metadata.onBehalfOf && (metadata.onBehalfOf.userId || metadata.onBehalfOf.name);

    const sections: PreviewSection[] = [
        {
            title: 'Guest Information',
            fields: [
                { label: 'Guest Name(s)', value: guestDisplay },
                { label: 'External Guest', value: metadata.isExternalGuest ? 'Yes' : 'No' },
                { label: 'Name Visible on Voucher', value: metadata.showNameOnVoucher !== false ? 'Yes' : 'No' },
                ...(metadata.voucherNumber
                    ? [{ label: 'Voucher Number', value: metadata.voucherNumber }]
                    : []),
                {
                    label: 'Charge To',
                    value: COMP_ALLOCATION_LABELS[metadata.allocationType] || metadata.allocationType || '—',
                },
                ...(metadata.percentageDiscount
                    ? [{ label: 'Percentage Discount', value: `${metadata.percentageDiscount}%` }]
                    : []),
            ],
        },
        ...(onBehalf
            ? [{
                title: 'Requestor',
                fields: [
                    { label: 'Submitted by', value: creator.display_name || '—' },
                    { label: 'Email', value: creator.email || '—' },
                    ...(creator.job_title ? [{ label: 'Job Title', value: creator.job_title }] : []),
                    { label: 'Submitted', value: formatDateTime(request?.created_at) },
                ],
            }]
            : []),
        ...(metadata.reason
            ? [{
                title: 'Reason for Complimentary',
                fields: [{ label: 'Reason', value: metadata.reason, fullWidth: true }],
            }]
            : []),
    ];

    if (units.length > 0) {
        sections.push({
            title: hasStayDates ? 'Hotel Bookings' : 'Business Units',
            content: hasStayDates ? (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={headCellStyle}>Hotel Unit</th>
                            <th style={headCellStyle}>Type</th>
                            <th style={headCellStyle}>Arrival</th>
                            <th style={headCellStyle}>Departure</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Nights</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Rooms</th>
                            <th style={headCellStyle}>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {units.map((unit: any, i: number) => (
                            <tr key={unit.id || i}>
                                <td style={cellStyle}>{unit.name || '—'}</td>
                                <td style={cellStyle}>
                                    {COMP_ACCOMMODATION_LABELS[unit.accommodationType] || unit.accommodationType || '—'}
                                </td>
                                <td style={cellStyle}>{unit.arrivalDate ? formatDate(unit.arrivalDate) : '—'}</td>
                                <td style={cellStyle}>{unit.departureDate ? formatDate(unit.departureDate) : '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{unit.numberOfNights || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{unit.numberOfRooms || '—'}</td>
                                <td style={cellStyle}>{unit.specialArrangements || '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={headCellStyle}>Business Unit</th>
                            <th style={headCellStyle}>Voucher Type</th>
                            <th style={headCellStyle}>Validity</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>People</th>
                            <th style={{ ...headCellStyle, textAlign: 'right' }}>Rooms</th>
                            <th style={headCellStyle}>Room Type</th>
                            <th style={headCellStyle}>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {units.map((unit: any, i: number) => {
                            const mealOnly = isMealOnly(unit.accommodationType);
                            return (
                                <tr key={unit.id || i}>
                                    <td style={cellStyle}>{unit.name || '—'}</td>
                                    <td style={cellStyle}>
                                        {COMP_ACCOMMODATION_LABELS[unit.accommodationType] || unit.accommodationType || '—'}
                                    </td>
                                    <td style={cellStyle}>{mealOnly ? '—' : (unit.voucherValidityPeriod || '—')}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                                        {mealOnly ? (unit.mealPeopleCount || '—') : (unit.numberOfPeople || '—')}
                                    </td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{mealOnly ? '—' : (unit.numberOfRooms || '—')}</td>
                                    <td style={cellStyle}>{mealOnly ? '—' : (unit.roomType || '—')}</td>
                                    <td style={cellStyle}>{unit.specialArrangements || '—'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            ),
        });
    }

    if (hasTravel) {
        const itinerary: any[] = Array.isArray(travel.itinerary) ? travel.itinerary : [];
        // The travel authorisation is a distinct document — start it on a fresh
        // page so the combined comp + travel preview / PDF reads as two pages.
        sections.push({
            title: 'Local Travel Authorization',
            pageBreakBefore: true,
            fields: [
                { label: 'Date of Intended Travel', value: formatDate(travel.dateOfIntendedTravel) },
                { label: 'Travel Mode', value: travel.travelMode || '—' },
                { label: 'Purpose of Travel', value: travel.purposeOfTravel || '—', fullWidth: true },
                ...(travel.accompanyingAssociates
                    ? [{ label: 'Accompanying Associates', value: travel.accompanyingAssociates, fullWidth: true }]
                    : []),
            ],
        });

        if (itinerary.length > 0) {
            sections.push({
                title: 'Travel Itinerary',
                content: (
                    <table style={docGridStyle}>
                        <thead>
                            <tr>
                                <th style={headCellStyle}>Date</th>
                                <th style={headCellStyle}>From</th>
                                <th style={headCellStyle}>To</th>
                                <th style={{ ...headCellStyle, textAlign: 'right' }}>KM</th>
                                <th style={headCellStyle}>Justification</th>
                            </tr>
                        </thead>
                        <tbody>
                            {itinerary.map((row: any, i: number) => (
                                <tr key={i}>
                                    <td style={cellStyle}>{formatDate(row.date)}</td>
                                    <td style={cellStyle}>{row.from || '—'}</td>
                                    <td style={cellStyle}>{row.to || '—'}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>{row.km || '—'}</td>
                                    <td style={cellStyle}>{row.justification || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ),
            });
        }
    }

    const supporting: any[] = Array.isArray(metadata.supportingDocuments) ? metadata.supportingDocuments : [];
    if (supporting.length > 0) {
        sections.push({
            title: 'Supporting Documents',
            content: (
                <table style={docGridStyle}>
                    <thead>
                        <tr>
                            <th style={{ ...headCellStyle, width: '8%' }}>#</th>
                            <th style={headCellStyle}>Label</th>
                            <th style={headCellStyle}>Description</th>
                            <th style={headCellStyle}>File</th>
                        </tr>
                    </thead>
                    <tbody>
                        {supporting.map((d: any, i: number) => (
                            <tr key={i}>
                                <td style={cellStyle}>{i + 1}</td>
                                <td style={cellStyle}>{d.label || '—'}</td>
                                <td style={cellStyle}>{d.description || '—'}</td>
                                <td style={cellStyle}>{d.name || d.filename || '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ),
        });
    }

    return sections;
}

const CAPEX_PAYBACK_LABELS: Record<string, string> = {
    '<6m': 'Less than 6 months',
    '6-12m': '6 to 12 months',
    '1-2y': '1 to 2 years',
    '2-3y': '2 to 3 years',
    '>3y': 'More than 3 years',
};

// Renders the exact CAPEX document (shared with the form page + the printable
// PDF) from a saved request's metadata and its resolved approver steps.
function buildCapexSections(request: any, metadata: any): PreviewSection[] {
    const data = metadata.capex || metadata;

    // Approver name per role: resolve each approverRoles[roleKey] id against the
    // request_steps' embedded approver display names.
    const roleMap: Record<string, any> = data.approverRoles || metadata.approverRoles || {};
    const steps: any[] = Array.isArray(request?.request_steps) ? request.request_steps : [];
    const nameById = new Map<string, string>();
    for (const step of steps) {
        const approver = Array.isArray(step.approver) ? step.approver[0] : step.approver;
        if (step.approver_user_id && approver?.display_name) {
            nameById.set(step.approver_user_id, approver.display_name);
        }
    }
    const approverNameByRole: Record<string, string> = {};
    for (const role of CAPEX_APPROVAL_ROLES) {
        const uid = roleMap[role.key];
        approverNameByRole[role.key] = uid ? nameById.get(uid) || '' : '';
    }

    // Recorded signature per role: the signature IMAGE of each approver who has
    // actually approved goes on that role's signature line (names are only a
    // caption under the line — never printed on it).
    const approverSignatureByRole: Record<string, { url: string | null; signedAt?: string | null }> = {};
    for (const role of CAPEX_APPROVAL_ROLES) {
        const uid = roleMap[role.key];
        const step =
            steps.find((s) => s.approver_role === role.key) ||
            (uid ? steps.find((s) => s.approver_user_id === uid) : null);
        if (!step) continue;
        const approval = Array.isArray(step.approvals) ? step.approvals[0] : null;
        if (!approval?.signed_at || approval.decision !== 'approved') continue;
        const approverId = approval?.approver?.id || approval?.approver_id || step.approver_user_id;
        approverSignatureByRole[role.key] = {
            url: signatureUrlForApproval(approval, approverId),
            signedAt: approval.signed_at,
        };
    }

    const quotes: any[] = Array.isArray(data.quotations) ? data.quotations : [];
    const preferred = quotes.find((q) => q.isSelectedSupplier);

    const parseNum = (s: any) => parseFloat(String(s ?? '').replace(/[^0-9.-]/g, '')) || 0;
    const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const isBudgeted = data.budgetType === 'budget';
    const budgetTypeMap: Record<string, string> = { budget: 'BUDGETED', 'non-budget': 'NON-BUDGETED', emergency: 'EMERGENCY' };

    return buildCapexPreviewSections({
        unit: data.unit || request?.creator?.business_unit?.name || '',
        department: data.department || request?.creator?.department?.name || '',
        projectName: data.projectName || request?.title || '',
        budgetTypeDisplay: budgetTypeMap[data.budgetType] || (data.budgetType ? String(data.budgetType).toUpperCase() : ''),
        currency: data.currency || 'USD',
        budgetAmount: data.budgetAmount || '',
        amountSpent: data.amountSpent || '',
        balance: isBudgeted ? fmt(parseNum(data.budgetAmount) - parseNum(data.amountSpent)) : '',
        projectCost: data.amount || '',
        balanceAfter: isBudgeted ? data.budgetBalance || '' : '',
        justification: data.justification || '',
        payback: data.paybackPeriod ? CAPEX_PAYBACK_LABELS[data.paybackPeriod] || data.paybackPeriod : '',
        npv: data.npv || '',
        irr: data.irr || '',
        evaluation: data.evaluation || '',
        quotations: quotes.map((q) => ({ supplier: q.supplierName || '', amount: q.amount || '' })),
        preferredSupplier: preferred?.supplierName || '',
        reason: preferred?.selectionReason || data.quotationJustification || '',
        fundingSource: data.fundingSource || '',
        requestedBy: data.requester || request?.creator?.display_name || data.department || '',
        approverNameByRole,
        approverSignatureByRole,
    });
}

function buildGenericSections(request: any, metadata: any): PreviewSection[] {
    const excluded = new Set([
        'approvers', 'approverRoles', 'watchers', 'documents', 'supportingDocuments',
        'useParallelApprovals', 'template_id', 'current_step',
        'type', 'requestType', 'category', 'workflow_category', 'referenceCode',
    ]);

    const fields: Array<{ label: string; value: ReactNode; fullWidth?: boolean }> = [];
    for (const [key, value] of Object.entries(metadata || {})) {
        if (excluded.has(key)) continue;
        if (value == null || value === '') continue;
        let rendered: ReactNode;
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            rendered = (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {value.map((v, i) => (
                        <li key={i}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</li>
                    ))}
                </ul>
            );
        } else if (typeof value === 'object') {
            rendered = (
                <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
                    {JSON.stringify(value, null, 2)}
                </pre>
            );
        } else if (typeof value === 'boolean') {
            rendered = value ? 'Yes' : 'No';
        } else {
            rendered = String(value);
        }
        fields.push({ label: humaniseKey(key), value: rendered, fullWidth: typeof value === 'object' });
    }

    return fields.length > 0 ? [{ title: 'Request Details', fields }] : [];
}

// ──────────────────────────────────────────────────────────────────────
// Document header by type — mirrors the originals used in the form pages.
// ──────────────────────────────────────────────────────────────────────
function buildDocumentHeader(metadata: any): DocumentHeader {
    const type = metadata?.type || metadata?.requestType;
    switch (type) {
        case 'travel_authorization':
            return { docNo: 'DOC NO: HR APX – TRAVEL AUTHORISATION', department: 'DEPARTMENT: HUMAN RESOURCES', page: 'PAGE: 1 of 1' };
        case 'petty_cash':
            return { docNo: 'DOC NO: FIN APX – PETTY CASH VOUCHER', department: 'DEPARTMENT: FINANCE', page: 'PAGE: 1 of 1' };
        case 'capex':
            return { docNo: 'DOC NO: FIN APX – CAPEX', department: 'DEPARTMENT: FINANCE', page: 'PAGE: 1 of 1' };
        case 'hotel_booking':
        case 'external_hotel_booking':
            return { docNo: 'DOC NO: OPS APX – HOTEL BOOKING', department: 'DEPARTMENT: OPERATIONS', page: 'PAGE: 1 of 1' };
        case 'voucher_request':
            return { docNo: 'DOC NO: COM APX – COMPLIMENTARY VOUCHER', department: 'DEPARTMENT: COMMERCIAL', page: 'PAGE: 1 of 1' };
        default:
            return { page: 'PAGE: 1 of 1' };
    }
}

// Shared section/header builder — used by the modal, the inline tab, and the
// client-side "download as PDF" print flow on the detail pages.
export function buildPreviewForRequest(request: any) {
    const metadata = request?.metadata || {};
    const type = metadata.type || metadata.requestType || '';
    const ref = metadata.referenceCode || `REQ-${String(request?.id || '').slice(0, 8).toUpperCase()}`;

    const titleByType: Record<string, string> = {
        travel_authorization: 'Travel Authorisation',
        petty_cash: 'Receipt of Petty Cash',
        capex: 'Capital Expenditure Request',
        hotel_booking: 'Hotel Booking Request',
        external_hotel_booking: 'External Hotel Booking',
        voucher_request: 'Complimentary Voucher Request',
    };

    // For travel authorisations, defer to the shared builder so the
    // document on this page matches the pre-submission form preview
    // byte-for-byte. The approval row inside that builder already shows
    // each role's name + signature image + signed-at date, which is what
    // an approver needs — so we skip the generic "Approval Signatures"
    // appendix in that case (it would duplicate the same information).
    const isTravelAuth = type === 'travel_authorization' || type === 'international_travel_authorization';
    const isCapex = type === 'capex';

    const documentHeader = isTravelAuth
        ? buildTravelAuthDocumentHeader(type === 'international_travel_authorization')
        : isCapex
            ? capexPreviewDocumentHeader
            : buildDocumentHeader(metadata);

    let typeSections: PreviewSection[] = [];
    switch (type) {
        case 'travel_authorization':
        case 'international_travel_authorization':
            typeSections = buildTravelAuthPreviewSections(travelAuthInputFromRequest(request));
            break;
        case 'petty_cash':
            typeSections = buildPettyCashSections(request, metadata);
            break;
        case 'capex':
            typeSections = buildCapexSections(request, metadata);
            break;
        case 'hotel_booking':
        case 'external_hotel_booking':
        case 'voucher_request':
            typeSections = buildCompSections(request, metadata);
            break;
        default:
            typeSections = buildGenericSections(request, metadata);
    }

    // Travel auth and CAPEX embed their own signature block, so don't append the
    // generic "Approval Signatures" table (it would duplicate the sign-offs).
    const sections: PreviewSection[] = isTravelAuth || isCapex
        ? typeSections
        : [...typeSections, buildApprovalSignaturesSection(request)];

    // Subtitle adapts to status — for in-progress requests we don't claim
    // "Fully Approved", we just stamp the submission date. The CAPEX form is a
    // faithful reproduction of the paper document, so it carries no subtitle.
    const isApproved = request?.status === 'approved';
    const subtitle = isCapex
        ? undefined
        : isApproved
            ? `${ref} — Fully Approved on ${formatDateTime(request?.updated_at || request?.created_at)}`
            : `${ref} — Submitted ${formatDateTime(request?.created_at)}`;

    return {
        title: isCapex ? capexPreviewTitle : (titleByType[type] || request?.title || 'Request'),
        subtitle,
        sections,
        documentHeader,
    };
}

/**
 * Inline variant — renders the same document body as the modal but as a
 * static element you can drop into a tab. Includes a Print button so the
 * inline view keeps feature parity with the modal.
 */
export function ApprovedRequestPreviewInline({ request, className }: InlineProps) {
    const printRef = useRef<HTMLDivElement>(null);
    const { title, subtitle, sections, documentHeader } = useMemo(
        () => buildPreviewForRequest(request),
        [request]
    );

    return (
        <div className={className}>
            <div className="flex items-center justify-end mb-3">
                <button
                    type="button"
                    onClick={() => printPreviewDocument(printRef.current, title)}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition"
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    Print / Save as PDF
                </button>
            </div>
            <RequestPreviewDocument
                ref={printRef}
                title={title}
                subtitle={subtitle}
                sections={sections}
                documentHeader={documentHeader}
            />
        </div>
    );
}

export default function ApprovedRequestPreview({ isOpen, onClose, request }: Props) {
    const { title, subtitle, sections, documentHeader } = useMemo(
        () => buildPreviewForRequest(request),
        [request]
    );

    return (
        <RequestPreviewModal
            isOpen={isOpen}
            onClose={onClose}
            mode="preview"
            title={title}
            subtitle={subtitle}
            sections={sections}
            documentHeader={documentHeader}
        />
    );
}
