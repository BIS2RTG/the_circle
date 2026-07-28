import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal, ReferenceCodeBanner } from '../../../components/ui';
import type { PreviewSection, DocumentHeader } from '../../../components/ui';
import { buildTravelAuthPreviewSections, buildTravelAuthDocumentHeader, ALLOCATION_UNITS } from '../../../lib/previews/travelAuthPreview';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { calculateTollgatesForItinerary, getTollgateRouteInfo, TollgateRouteType } from '../../../lib/formConfig';
import { SupportingDocuments, uploadSupportingDocuments, makeSupportingDoc, type SupportingDoc } from '../../../components/requests/SupportingDocuments';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';
import { isApproverRowLocked } from '../../../lib/approverLocking';

interface ItineraryRow {
    date: string;
    from: string;
    fromCustom?: string;
    to: string;
    toCustom?: string;
    km: string;
    justification: string;
}

interface CostAllocation {
    corp: string;
    mrc: string;
    nah: string;
    rth: string;
    khcc: string;
    brh: string;
    vfrh: string;
    azam: string;
}

// Business units for travel itinerary (excluding RTG SA, Heritage Expeditions, Gateway Stream, Head Office)
const TRAVEL_LOCATIONS = [
    { code: 'MRC', name: 'Montclair Resort and Conferencing (MRC)', city: 'Nyanga' },
    { code: 'NAH', name: 'New Ambassador Hotel (NAH)', city: 'Harare' },
    { code: 'RTH', name: 'Rainbow Towers Hotel (RTH)', city: 'Harare' },
    { code: 'KHCC', name: 'KHCC Conference Centre', city: 'Kadoma' },
    { code: 'BRH', name: 'Bulawayo Rainbow Hotel (BRH)', city: 'Bulawayo' },
    { code: 'VFRH', name: 'Victoria Falls Rainbow Hotel (VFRH)', city: 'Victoria Falls' },
    { code: 'AZAM', name: 'A\'Zambezi River Lodge (AZAM)', city: 'Victoria Falls' },
    { code: 'OTHER', name: 'Other (Manual Entry)', city: '' },
];

// Inter-business unit distances in KM (exact values from distance matrix)
const DISTANCE_MATRIX: Record<string, Record<string, number>> = {
    'RTH':  { 'RTH': 0,   'NAH': 2.1,   'KHCC': 139,   'BRH': 440,   'AZAM': 725,   'VFRH': 721,   'MRC': 250 },
    'NAH':  { 'RTH': 2.1, 'NAH': 0,     'KHCC': 136.9, 'BRH': 437.9, 'AZAM': 722.9, 'VFRH': 718.9, 'MRC': 247.9 },
    'KHCC': { 'RTH': 139, 'NAH': 140, 'KHCC': 0,     'BRH': 301,   'AZAM': 585,   'VFRH': 582,   'MRC': 389 },
    'BRH':  { 'RTH': 439, 'NAH': 441, 'KHCC': 300,   'BRH': 0,     'AZAM': 454,   'VFRH': 450,   'MRC': 593 },
    'AZAM': { 'RTH': 725, 'NAH': 722.9, 'KHCC': 585,   'BRH': 454,   'AZAM': 0,     'VFRH': 4,     'MRC': 973 },
    'VFRH': { 'RTH': 721, 'NAH': 718.9, 'KHCC': 581,   'BRH': 450,   'AZAM': 4,     'VFRH': 0,     'MRC': 969 },
    'MRC':  { 'RTH': 250, 'NAH': 247.9, 'KHCC': 389,   'BRH': 593,   'AZAM': 973,   'VFRH': 969,   'MRC': 0 },
};

// Get distance between two locations
const getDistance = (from: string, to: string): number => {
    if (!from || !to) return 0;
    return DISTANCE_MATRIX[from]?.[to] || 0;
};

interface BudgetItem {
    quantity: string;
    unitCost: string;
    totalCost: string;
    description?: string;
}

interface TollgateEntry {
    road: string;
    quantity: string;
    unitCost: string;
    totalCost: string;
}

interface AACalculatorData {
    engineCapacity: string;
    fuelType: 'petrol' | 'diesel';
}

// AA Rate table based on engine capacity and fuel type (USD per km).
// Defaults mirror the AA Zimbabwe "Estimated Vehicle Operating Costs" schedule
// (wet rate). Administrators can override these in Admin → Financial Rates; the
// live values are loaded from /api/settings/rates at runtime.
type AARateTable = Record<string, { petrol: number; diesel: number }>;
const AA_RATES_DEFAULTS: AARateTable = {
    '1.1L-1.5L': { petrol: 0.32, diesel: 0.30 },
    '1.6L-2.0L': { petrol: 0.40, diesel: 0.36 },
    '2.1L-3.0L': { petrol: 0.54, diesel: 0.50 },
    'Above 3.0L': { petrol: 0.66, diesel: 0.62 },
};

interface TravelData {
    dateOfIntendedTravel: string;
    purposeOfTravel: string;
    accompanyingAssociates: string;
    travelMode: string;
    vehicleRegistration?: string;
    acceptConditions: boolean;
    itinerary: ItineraryRow[];
    budget: {
        fuel: BudgetItem;
        aaRates: BudgetItem;
        airBusTickets: BudgetItem;
        conferencingCost: BudgetItem;
        tollgates: TollgateEntry[];
        // Miscellaneous costs — a free list of extra line items (shown before tollgates).
        miscCosts: BudgetItem[];
    };
}

export default function TravelAuthPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName, loading: hrimsLoading } = useUserHrimsProfile();
    // International travel shares this page but swaps the itinerary to manual free-text entry
    // with no business-unit dropdown and no auto-km calculation or unit-based cost allocation.
    const isInternational = typeof router.pathname === 'string' && router.pathname.includes('international');
    const formKindLabel = isInternational
        ? 'International Travel Authorization'
        : 'Local Travel Authorization';
    const travelRequestType = isInternational
        ? 'international_travel_authorization'
        : 'travel_authorization';
    const [loading, setLoading] = useState(false);
    const [savingDraft, setSavingDraft] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Edit mode state
    const { edit: editRequestId, approver: isApproverEdit } = router.query;
    const isEditMode = !!editRequestId;
    const isApproverEditing = isApproverEdit === 'true';
    const [loadingRequest, setLoadingRequest] = useState(false);
    const [originalTravelData, setOriginalTravelData] = useState<TravelData | null>(null);
    const [originalApprovers, setOriginalApprovers] = useState<Record<string, string> | null>(null);
    const [requestStatus, setRequestStatus] = useState<string>('draft');

    // Supporting documents (file + label + description) and file-on-behalf-of.
    const [supportingDocs, setSupportingDocs] = useState<SupportingDoc[]>([]);
    const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);

    // When filing on behalf of a principal, the document must read as if THEY
    // filled it — so the preview needs the principal's department/business unit,
    // not the assistant's. Resolve them from HRIMS by the principal's email.
    const [onBehalfProfile, setOnBehalfProfile] = useState<{ department?: string; businessUnit?: string } | null>(null);
    const [onBehalfProfileLoading, setOnBehalfProfileLoading] = useState(false);
    useEffect(() => {
        const email = onBehalfOf?.email;
        if (!email) { setOnBehalfProfile(null); setOnBehalfProfileLoading(false); return; }
        let cancelled = false;
        setOnBehalfProfileLoading(true);
        (async () => {
            try {
                const res = await fetch(`/api/hrims/employee-by-email?email=${encodeURIComponent(email)}`);
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                setOnBehalfProfile({
                    department: data?.department?.name || undefined,
                    businessUnit: data?.businessUnit?.name || undefined,
                });
            } catch {
                if (!cancelled) setOnBehalfProfile(null);
            } finally {
                if (!cancelled) setOnBehalfProfileLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [onBehalfOf?.email]);

    // Requestor identity shown on the form + document. When filing on behalf of a
    // principal, these resolve to the PRINCIPAL (autofilled on selection) so the
    // form reads as if they filled it themselves; otherwise they resolve to the
    // signed-in user's own HRIMS profile.
    const isOnBehalf = !!onBehalfOf?.userId;
    const requestorName = isOnBehalf
        ? (onBehalfOf?.name || undefined)
        : (user?.display_name || session?.user?.name || undefined);
    const requestorDepartment = isOnBehalf ? (onBehalfProfile?.department || undefined) : (departmentName || undefined);
    const requestorBusinessUnit = isOnBehalf ? (onBehalfProfile?.businessUnit || undefined) : (businessUnitName || undefined);

    // AA Rates Calculator state (simplified)
    const [aaCalculator, setAACalculator] = useState<AACalculatorData>({
        engineCapacity: '1.6L-2.0L',
        fuelType: 'petrol',
    });

    // Live AA rate table — starts from the AA Zimbabwe defaults and is replaced
    // with any admin overrides configured in Admin → Financial Rates.
    const [aaRates, setAaRates] = useState<AARateTable>(AA_RATES_DEFAULTS);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/settings/rates');
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled && data?.aa) setAaRates((prev) => ({ ...prev, ...data.aa }));
            } catch {
                // Keep defaults on failure.
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Get AA Rate based on engine capacity and fuel type
    const getAARate = (): number => {
        const rates = aaRates[aaCalculator.engineCapacity];
        if (!rates) return 0;
        return rates[aaCalculator.fuelType];
    };

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const todayISO = new Date().toISOString().split('T')[0];

    const [travelData, setTravelData] = useState<TravelData>({
        dateOfIntendedTravel: '',
        purposeOfTravel: '',
        accompanyingAssociates: '',
        travelMode: '',
        acceptConditions: false,
        itinerary: [{ date: '', from: '', to: '', km: '', justification: '' }],
        budget: {
            fuel: { quantity: '', unitCost: '', totalCost: '' },
            aaRates: { quantity: '', unitCost: '0.32', totalCost: '' },
            airBusTickets: { quantity: '', unitCost: '', totalCost: '' },
            conferencingCost: { quantity: '', unitCost: '', totalCost: '' },
            tollgates: [{ road: '', quantity: '1', unitCost: '', totalCost: '' }],
            miscCosts: [],
        },
    });

    // Auto-fill the AA "Travel Cost" budget line from the calculator: whenever the
    // itinerary distance, engine/fuel selection, or the rate table changes (and the
    // travel is by personal motor vehicle), recompute km × rate into budget.aaRates.
    // No manual "Apply" step — the calculator value flows straight into the budget.
    useEffect(() => {
        if (travelData.travelMode !== 'personal_motor_vehicle') return;
        const rate = getAARate();
        const totalKm = travelData.itinerary.reduce((sum, row) => sum + (parseFloat(row.km) || 0), 0);
        const totalCost = (totalKm * rate).toFixed(2);
        setTravelData(prev => {
            const cur = prev.budget.aaRates;
            if (cur.quantity === String(totalKm) && cur.unitCost === rate.toFixed(2) && cur.totalCost === totalCost) {
                return prev; // no change — avoid an update loop
            }
            return {
                ...prev,
                budget: {
                    ...prev.budget,
                    aaRates: { quantity: String(totalKm), unitCost: rate.toFixed(2), totalCost },
                },
            };
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [travelData.travelMode, travelData.itinerary, aaCalculator.engineCapacity, aaCalculator.fuelType, aaRates]);

    // Reference code (unique identifier shown in the form header)
    const [referenceCode, setReferenceCode] = useState<string | null>(null);
    const [existingReferenceCode, setExistingReferenceCode] = useState<string | null>(null);

    // Unsaved-changes tracking — flipped true on first real user interaction via form onChange.
    const [isDirty, setIsDirty] = useState(false);

    const approvalRoles = [
        { key: 'line_manager', label: 'Line Manager', description: 'Recommendation' },
        { key: 'functional_head', label: 'Functional Head', description: 'Functional Approval' },
        { key: 'hrd', label: 'Chief Human Capital Officer', description: 'Human Capital Approval' },
        { key: 'ceo', label: 'CEO', description: 'Authorisation' },
    ];

    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        line_manager: '', functional_head: '', hrd: '', ceo: '',
    });
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        line_manager: '', functional_head: '', hrd: '', ceo: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
    const [loadingApproverResolution, setLoadingApproverResolution] = useState(!isEditMode);
    const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});

    // Emergency request state (for travel within 7 days)
    const [isEmergencyRequest, setIsEmergencyRequest] = useState(false);
    const [emergencyReason, setEmergencyReason] = useState('');

    // Tollgate route type selection (premium or standard)
    const [tollgateRouteType, setTollgateRouteType] = useState<TollgateRouteType>('premium');

    // Cost allocation is entered by the requestor (tick the relevant business
    // unit and indicate the cost). Keyed by unit code (see ALLOCATION_UNITS);
    // persisted to metadata.costAllocation and rendered on the preview + PDF.
    const [costAllocation, setCostAllocation] = useState<Record<string, string>>({});

    // Autosave / crash recovery (serializable slices only). Disabled in edit mode.
    useFormAutosave({
        // Local and international share this component — keep their drafts separate.
        formKey: isInternational ? 'international-travel-auth' : 'travel-auth',
        enabled: !isEditMode,
        data: { travelData, costAllocation, selectedApprovers, aaCalculator, isEmergencyRequest, emergencyReason, tollgateRouteType },
        onRestore: (saved) => {
            if (saved.travelData) setTravelData(saved.travelData);
            if (saved.costAllocation && typeof saved.costAllocation === 'object') setCostAllocation(saved.costAllocation);
            if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
            if (saved.aaCalculator) setAACalculator(saved.aaCalculator);
            if (typeof saved.isEmergencyRequest === 'boolean') setIsEmergencyRequest(saved.isEmergencyRequest);
            if (typeof saved.emergencyReason === 'string') setEmergencyReason(saved.emergencyReason);
            if (saved.tollgateRouteType) setTollgateRouteType(saved.tollgateRouteType);
            setIsDirty(true);
        },
    });

    // Check if travel date is within 7 days
    const isTravelWithin7Days = () => {
        if (!travelData.dateOfIntendedTravel) return false;
        const travelDate = new Date(travelData.dateOfIntendedTravel);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffTime = travelDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays < 7 && diffDays >= 0;
    };

    const addItineraryRow = () => {
        setTravelData(prev => ({
            ...prev,
            // New itinerary rows inherit the intended-travel date so the user
            // doesn't have to retype it for each leg.
            itinerary: [...prev.itinerary, { date: prev.dateOfIntendedTravel || '', from: '', to: '', km: '', justification: '' }]
        }));
    };

    const updateItineraryRow = (index: number, field: string, value: string) => {
        setTravelData(prev => {
            const updatedItinerary = prev.itinerary.map((row, i) => {
                if (i !== index) return row;
                const updatedRow = { ...row, [field]: value };
                // Local travel only: auto-calculate KM when From or To changes between known business units.
                // International travel leaves km as manual entry.
                if (!isInternational && (field === 'from' || field === 'to')) {
                    const fromCode = field === 'from' ? value : row.from;
                    const toCode = field === 'to' ? value : row.to;
                    if (fromCode && toCode && fromCode !== 'OTHER' && toCode !== 'OTHER') {
                        updatedRow.km = getDistance(fromCode, toCode).toString();
                    } else if (fromCode === 'OTHER' || toCode === 'OTHER') {
                        // Clear KM when switching to OTHER so user can enter manually
                        updatedRow.km = '';
                    }
                }
                return updatedRow;
            });
            return { ...prev, itinerary: updatedItinerary };
        });
        // The AA travel-cost budget line recalculates automatically via the effect above.
    };

    const removeItineraryRow = (index: number) => {
        if (travelData.itinerary.length > 1) {
            setTravelData(prev => ({ ...prev, itinerary: prev.itinerary.filter((_, i) => i !== index) }));
        }
    };

    // Calculate total tollgates cost
    const calculateTollgatesTotal = () => {
        const tollgates = Array.isArray(travelData.budget.tollgates) ? travelData.budget.tollgates : [];
        return tollgates.reduce((sum, t) => sum + (parseFloat(t.totalCost) || 0), 0);
    };

    const calculateGrandTotal = () => {
        const b = travelData.budget;
        const tollgatesTotal = calculateTollgatesTotal();
        const miscTotal = calculateMiscTotal();
        return [b.aaRates.totalCost, b.airBusTickets.totalCost, b.conferencingCost.totalCost]
            .reduce((sum, val) => sum + (parseFloat(val) || 0), tollgatesTotal + miscTotal).toFixed(2);
    };

    // Calculate cost allocation based on itinerary destinations
    const calculateCostAllocation = (): CostAllocation => {
        const grandTotal = parseFloat(calculateGrandTotal()) || 0;
        const unitCodes = ['MRC', 'NAH', 'RTH', 'KHCC', 'BRH', 'VFRH', 'AZAM'];
        const unitKeys: (keyof CostAllocation)[] = ['mrc', 'nah', 'rth', 'khcc', 'brh', 'vfrh', 'azam'];
        
        // Count visits to each unit from itinerary (both from and to)
        const visitCounts: Record<string, number> = {};
        travelData.itinerary.forEach(row => {
            if (row.from && row.from !== 'OTHER') {
                visitCounts[row.from] = (visitCounts[row.from] || 0) + 1;
            }
            if (row.to && row.to !== 'OTHER') {
                visitCounts[row.to] = (visitCounts[row.to] || 0) + 1;
            }
        });
        
        const totalVisits = Object.values(visitCounts).reduce((sum, count) => sum + count, 0);
        
        const allocation: CostAllocation = { corp: '', mrc: '', nah: '', rth: '', khcc: '', brh: '', vfrh: '', azam: '' };
        
        if (totalVisits > 0 && grandTotal > 0) {
            unitCodes.forEach((code, idx) => {
                const visits = visitCounts[code] || 0;
                if (visits > 0) {
                    const share = (visits / totalVisits) * grandTotal;
                    allocation[unitKeys[idx]] = share.toFixed(2);
                }
            });
        }
        
        return allocation;
    };

    const updateBudgetItem = (item: 'fuel' | 'aaRates' | 'airBusTickets' | 'conferencingCost', field: string, value: string) => {
        setTravelData(prev => {
            const currentItem = prev.budget[item];
            const updatedItem = { ...currentItem, [field]: value };
            if (field === 'quantity' || field === 'unitCost') {
                const qty = parseFloat(field === 'quantity' ? value : updatedItem.quantity) || 0;
                const uc = parseFloat(field === 'unitCost' ? value : updatedItem.unitCost) || 0;
                updatedItem.totalCost = (qty * uc).toFixed(2);
            }
            return { ...prev, budget: { ...prev.budget, [item]: updatedItem } };
        });
    };

    // Miscellaneous cost management (multi-line, shown before the tollgates section).
    const addMiscRow = () => {
        setTravelData(prev => ({
            ...prev,
            budget: {
                ...prev.budget,
                miscCosts: [...(Array.isArray(prev.budget.miscCosts) ? prev.budget.miscCosts : []), { description: '', quantity: '', unitCost: '', totalCost: '' }],
            },
        }));
    };

    const updateMiscRow = (index: number, field: keyof BudgetItem, value: string) => {
        setTravelData(prev => {
            const updated = (Array.isArray(prev.budget.miscCosts) ? prev.budget.miscCosts : []).map((row, i) => {
                if (i !== index) return row;
                const next = { ...row, [field]: value };
                if (field === 'quantity' || field === 'unitCost') {
                    const qty = parseFloat(field === 'quantity' ? value : next.quantity) || 0;
                    const uc = parseFloat(field === 'unitCost' ? value : next.unitCost) || 0;
                    next.totalCost = (qty * uc).toFixed(2);
                }
                return next;
            });
            return { ...prev, budget: { ...prev.budget, miscCosts: updated } };
        });
    };

    const removeMiscRow = (index: number) => {
        setTravelData(prev => ({
            ...prev,
            budget: {
                ...prev.budget,
                miscCosts: (Array.isArray(prev.budget.miscCosts) ? prev.budget.miscCosts : []).filter((_, i) => i !== index),
            },
        }));
    };

    const calculateMiscTotal = () => {
        const misc = Array.isArray(travelData.budget.miscCosts) ? travelData.budget.miscCosts : [];
        return misc.reduce((sum, m) => sum + (parseFloat(m.totalCost) || 0), 0);
    };

    // ── Cost allocation ──
    // The requestor simply TICKS the unit(s) that carry the trip cost. A single
    // ticked unit carries the whole grand total (no figure needed). Ticking more
    // than one puts it into "split" mode where each unit's share is entered and
    // must add up to the full grand total (every cent allocated) before submit.
    // Defined AFTER calculateMiscTotal because it calls calculateGrandTotal,
    // which depends on it (avoids a temporal-dead-zone error at render).
    const allocationGrandTotal = parseFloat(calculateGrandTotal()) || 0;
    const allocationCodes = Object.keys(costAllocation);
    const isSplitAllocation = allocationCodes.length > 1;
    const allocationEnteredTotal = allocationCodes.reduce(
        (sum, code) => sum + (parseFloat(costAllocation[code]) || 0), 0
    );
    const allocationRemaining = allocationGrandTotal - allocationEnteredTotal;
    const allocationFullyAllocated = !isSplitAllocation || Math.abs(allocationRemaining) < 0.01;

    // Finalised allocation to persist / preview: one unit → full total; a split
    // → the entered figures, rounded to cents.
    const finalizeCostAllocation = (): Record<string, string> => {
        const codes = Object.keys(costAllocation);
        if (codes.length === 0) return {};
        if (codes.length === 1) return { [codes[0]]: allocationGrandTotal.toFixed(2) };
        const out: Record<string, string> = {};
        for (const code of codes) out[code] = (parseFloat(costAllocation[code]) || 0).toFixed(2);
        return out;
    };

    // Tollgate management functions
    const addTollgateRow = () => {
        setTravelData(prev => ({
            ...prev,
            budget: {
                ...prev.budget,
                tollgates: [...(Array.isArray(prev.budget.tollgates) ? prev.budget.tollgates : []), { road: '', quantity: '1', unitCost: '', totalCost: '' }]
            }
        }));
    };

    const updateTollgateRow = (index: number, field: keyof TollgateEntry, value: string) => {
        setTravelData(prev => {
            const updatedTollgates = (Array.isArray(prev.budget.tollgates) ? prev.budget.tollgates : []).map((t, i) => {
                if (i !== index) return t;
                const updated = { ...t, [field]: value };
                if (field === 'quantity' || field === 'unitCost') {
                    const qty = parseFloat(field === 'quantity' ? value : updated.quantity) || 0;
                    const uc = parseFloat(field === 'unitCost' ? value : updated.unitCost) || 0;
                    updated.totalCost = (qty * uc).toFixed(2);
                }
                return updated;
            });
            return { ...prev, budget: { ...prev.budget, tollgates: updatedTollgates } };
        });
    };

    const removeTollgateRow = (index: number) => {
        const tollgates = Array.isArray(travelData.budget.tollgates) ? travelData.budget.tollgates : [];
        if (tollgates.length > 1) {
            setTravelData(prev => ({
                ...prev,
                budget: {
                    ...prev.budget,
                    tollgates: (Array.isArray(prev.budget.tollgates) ? prev.budget.tollgates : []).filter((_, i) => i !== index)
                }
            }));
        }
    };

    // Auto-calculate tollgates based on itinerary routes
    const autoCalculateTollgates = () => {
        const calculatedTollgates = calculateTollgatesForItinerary(travelData.itinerary, tollgateRouteType);
        setTravelData(prev => ({
            ...prev,
            budget: {
                ...prev.budget,
                tollgates: calculatedTollgates,
            }
        }));
    };

    // Get tollgate summary for display
    const getTollgateSummary = () => {
        const routes: string[] = [];
        for (const row of travelData.itinerary) {
            if (!row.from || !row.to || row.from === 'OTHER' || row.to === 'OTHER') continue;
            const info = getTollgateRouteInfo(row.from, row.to);
            if (info && (info.premium > 0 || info.standard > 0)) {
                routes.push(`${row.from}→${row.to}: ${info.premium} premium ($${info.premiumCost}), ${info.standard} standard ($${info.standardCost})`);
            }
        }
        return routes;
    };

    useEffect(() => {
        if (status === 'unauthenticated') router.push('/');
    }, [status, router]);

    // Fetch existing request data when in edit mode
    useEffect(() => {
        const fetchExistingRequest = async () => {
            if (!editRequestId || typeof editRequestId !== 'string') return;
            
            setLoadingRequest(true);
            try {
                const response = await fetch(`/api/requests/${editRequestId}`);
                if (!response.ok) throw new Error('Failed to fetch request');
                const data = await response.json();
                const request = data.request;
                const metadata = request.metadata || {};

                setRequestStatus(request.status || 'draft');
                if (metadata.referenceCode) setExistingReferenceCode(metadata.referenceCode);

                // Default budget structure
                const defaultBudget = {
                    fuel: { quantity: '', unitCost: '', totalCost: '' },
                    aaRates: { quantity: '', unitCost: '0.32', totalCost: '' },
                    airBusTickets: { quantity: '', unitCost: '', totalCost: '' },
                    conferencingCost: { quantity: '', unitCost: '', totalCost: '' },
                    tollgates: [{ road: '', quantity: '1', unitCost: '', totalCost: '' }] as TollgateEntry[],
                    miscCosts: [] as BudgetItem[],
                };

                // Merge existing budget with defaults to ensure all items exist.
                // Back-compat: a legacy single `other` line is folded into miscCosts.
                const existingBudget = metadata.budget || {};
                const existingMisc: BudgetItem[] = Array.isArray(existingBudget.miscCosts)
                    ? existingBudget.miscCosts
                    : (existingBudget.other && (existingBudget.other.description || existingBudget.other.totalCost)
                        ? [existingBudget.other]
                        : []);
                const mergedBudget = {
                    fuel: { ...defaultBudget.fuel, ...(existingBudget.fuel || {}) },
                    aaRates: { ...defaultBudget.aaRates, ...(existingBudget.aaRates || {}) },
                    airBusTickets: { ...defaultBudget.airBusTickets, ...(existingBudget.airBusTickets || {}) },
                    conferencingCost: { ...defaultBudget.conferencingCost, ...(existingBudget.conferencingCost || {}) },
                    tollgates: Array.isArray(existingBudget.tollgates) && existingBudget.tollgates.length > 0
                        ? existingBudget.tollgates
                        : defaultBudget.tollgates,
                    miscCosts: existingMisc,
                };

                // Store original data for comparison
                const originalData: TravelData = {
                    dateOfIntendedTravel: metadata.dateOfIntendedTravel || '',
                    purposeOfTravel: metadata.purposeOfTravel || request.description || '',
                    accompanyingAssociates: metadata.accompanyingAssociates || '',
                    travelMode: metadata.travelMode || '',
                    acceptConditions: metadata.acceptConditions || false,
                    itinerary: metadata.itinerary || [{ date: '', from: '', to: '', km: '', justification: '' }],
                    budget: mergedBudget,
                };
                setOriginalTravelData(originalData);

                // Pre-fill form with existing data
                setTravelData(originalData);

                // Restore the requestor's cost allocation across edits — normalise
                // legacy/lowercase unit keys (the old HRD scheme used "mrc",
                // "azam", …) to the canonical codes and drop zero/empty entries so
                // a single funded unit doesn't render as an all-units "split".
                if (metadata.costAllocation && typeof metadata.costAllocation === 'object') {
                    const canon = new Map<string, string>(ALLOCATION_UNITS.map(u => [u.code.toLowerCase(), u.code]));
                    canon.set('azam', 'AZRL');
                    const cleaned: Record<string, string> = {};
                    for (const [k, v] of Object.entries(metadata.costAllocation as Record<string, any>)) {
                        const code = canon.get(String(k).toLowerCase());
                        const num = parseFloat(String(v ?? ''));
                        if (code && Number.isFinite(num) && num > 0) cleaned[code] = String(v);
                    }
                    setCostAllocation(cleaned);
                }

                // Preserve the on-behalf beneficiary across edits.
                if (metadata.onBehalfOf?.userId) setOnBehalfOf(metadata.onBehalfOf);

                // Set approvers and store original for change tracking
                const approverRolesData = metadata.approverRoles || {};
                if (approverRolesData && typeof approverRolesData === 'object') {
                    setSelectedApprovers(prev => ({ ...prev, ...approverRolesData }));
                    setOriginalApprovers({ hod: '', hr_director: '', finance_director: '', ceo: '', ...approverRolesData });
                }
            } catch (err: any) {
                console.error('Error fetching request:', err);
                setError('Failed to load request data');
            } finally {
                setLoadingRequest(false);
            }
        };

        if (status === 'authenticated' && editRequestId) {
            fetchExistingRequest();
        }
    }, [editRequestId, status]);

    // In edit mode, surface any already-uploaded supporting documents so the
    // requester can see/remove them (files can't be re-read, so they're shown
    // as existing entries).
    useEffect(() => {
        if (!(status === 'authenticated' && editRequestId && typeof editRequestId === 'string')) return;
        (async () => {
            try {
                const res = await fetch(`/api/requests/${editRequestId}/documents`);
                if (!res.ok) return;
                const data = await res.json();
                const docs = (data.documents || []).map((d: any) =>
                    makeSupportingDoc({
                        label: d.label || '',
                        description: d.description || '',
                        existing: { id: d.id, filename: d.filename, download_url: d.download_url },
                    })
                );
                if (docs.length > 0) setSupportingDocs(docs);
            } catch {
                // Non-fatal.
            }
        })();
    }, [editRequestId, status]);

    useEffect(() => {
        const fetchUsers = async () => {
            try {
                const response = await fetch('/api/users');
                if (response.ok) {
                    const data = await response.json();
                    setUsers(data.users || []);
                }
            } catch (err) { console.error('Failed to fetch users:', err); }
            finally { setLoadingUsers(false); }
        };
        if (status === 'authenticated') fetchUsers();
    }, [status]);

    // Auto-resolve approvers from HRIMS organogram (only on new requests, not edits)
    useEffect(() => {
        const resolveApprovers = async () => {
            if (!session?.user?.email || isEditMode) { setLoadingApproverResolution(false); return; }
            setLoadingApproverResolution(true);
            try {
                console.log('[travel-auth] Resolving approvers for email:', session.user.email);
                const response = await fetch(`/api/hrims/resolve-approvers?email=${encodeURIComponent(session.user.email)}&formType=travel`);
                const data = await response.json();
                console.log('[travel-auth] Approver resolution response:', JSON.stringify(data, null, 2));
                if (response.ok && data.approvers) {
                    const resolved: Record<string, boolean> = {};
                    const newApprovers: Record<string, string> = {};
                    for (const [roleKey, approver] of Object.entries(data.approvers)) {
                        if (approver && (approver as any).userId) {
                            newApprovers[roleKey] = (approver as any).userId;
                            resolved[roleKey] = true;
                        }
                    }
                    if (Object.keys(newApprovers).length > 0) {
                        setSelectedApprovers(prev => ({ ...prev, ...newApprovers }));
                        setAutoResolvedRoles(resolved);
                    }
                } else {
                    console.error('Approver resolution failed:', data.error || 'Unknown error');
                }
            } catch (err) {
                console.error('Failed to auto-resolve approvers:', err);
            } finally {
                setLoadingApproverResolution(false);
            }
        };
        if (status === 'authenticated') resolveApprovers();
    }, [status, session?.user?.email, isEditMode]);

    const getFilteredUsersForRole = (roleKey: string) => {
        const searchTerm = approverSearch[roleKey] || '';
        const alreadySelectedIds = Object.values(selectedApprovers).filter(id => id);
        // The requester can never approve their own request — hide themselves from the picker.
        const currentUserId = (session?.user as any)?.id;
        return users.filter(u => u.id !== currentUserId).filter(u => {
            const matchesSearch = searchTerm ? (u.display_name?.toLowerCase().includes(searchTerm.toLowerCase()) || u.email?.toLowerCase().includes(searchTerm.toLowerCase())) : true;
            const notAlreadySelected = !alreadySelectedIds.includes(u.id) || selectedApprovers[roleKey] === u.id;
            return matchesSearch && notAlreadySelected;
        });
    };

    const handleSelectApprover = (roleKey: string, userId: string) => {
        setSelectedApprovers(prev => ({ ...prev, [roleKey]: userId }));
        setApproverSearch(prev => ({ ...prev, [roleKey]: '' }));
        setShowApproverDropdown(null);
    };

    const handleRemoveApprover = (roleKey: string) => {
        setSelectedApprovers(prev => ({ ...prev, [roleKey]: '' }));
    };

    const validateForm = (): string[] => {
        const errors: string[] = [];
        const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);

        if (!travelData.dateOfIntendedTravel) errors.push('Date of intended travel is required');
        else if (new Date(travelData.dateOfIntendedTravel) < todayDate) errors.push('Date of intended travel cannot be in the past');
        
        // 7-day advance validation
        if (travelData.dateOfIntendedTravel && isTravelWithin7Days()) {
            if (!isEmergencyRequest) {
                errors.push('Travel within 7 days requires flagging as an emergency request');
            } else if (!emergencyReason.trim()) {
                errors.push('Emergency reason is required for travel within 7 days');
            }
        }

        if (!travelData.purposeOfTravel.trim()) errors.push('Purpose of travel is required');
        if (!travelData.travelMode.trim()) errors.push('Travel mode is required');
        if (travelData.travelMode === 'personal_motor_vehicle' && !travelData.vehicleRegistration?.trim()) {
            errors.push('Vehicle registration number is required for personal motor vehicle');
        }
        if (!travelData.acceptConditions) errors.push('You must accept the travel conditions');

        const hasValidItinerary = travelData.itinerary.some(row => row.date || row.from || row.to);
        if (!hasValidItinerary) errors.push('At least one travel itinerary row is required');

        // Cost-allocation split must account for every cent of the grand total.
        if (!isInternational && isSplitAllocation && !allocationFullyAllocated) {
            errors.push(
                `Cost allocation must total USD ${allocationGrandTotal.toFixed(2)} — every cent must be allocated ` +
                `(currently USD ${allocationEnteredTotal.toFixed(2)}).`
            );
        }

        {
            const b = travelData.budget;
            const tollgatesTotal = calculateTollgatesTotal();
            const miscTotal = calculateMiscTotal();
            const hasValidBudget = [b.fuel.totalCost, b.aaRates.totalCost, b.airBusTickets.totalCost, b.conferencingCost.totalCost]
                .some(val => parseFloat(val) > 0) || tollgatesTotal > 0 || miscTotal > 0;
            if (!hasValidBudget) errors.push('At least one travel budget item is required');
        }

        // Approvers are optional per step — the requestor need not fill every
        // role — but at least one is required so the request has an approval
        // chain to route through.
        const anyApproverSelected = [
            selectedApprovers.line_manager,
            selectedApprovers.functional_head,
            selectedApprovers.hrd,
            selectedApprovers.ceo,
        ].some(Boolean);
        if (!anyApproverSelected) errors.push('Please select at least one approver');

        return errors;
    };

    // Handle approver save (edit mode with change tracking).
    //
    // Approvers are NOT the request creator, so this must go through the
    // approver-edit endpoint (the generic PUT is creator-only). It merges each
    // fieldChange into metadata — including object values like the travel budget
    // (kept as objects, not stringified). This does not approve the request; the
    // approver approves separately afterwards.
    const handleApproverSave = async () => {
        setLoading(true);
        setError(null);

        try {
            const fieldChanges: Array<{ fieldName: string; oldValue: any; newValue: any }> = [];
            const orig = originalTravelData;

            const pushIfChanged = (fieldName: string, oldValue: any, newValue: any) => {
                if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) {
                    fieldChanges.push({ fieldName, oldValue, newValue });
                }
            };

            if (orig) {
                pushIfChanged('purposeOfTravel', orig.purposeOfTravel, travelData.purposeOfTravel);
                pushIfChanged('travelMode', orig.travelMode, travelData.travelMode);
                pushIfChanged('itinerary', orig.itinerary, travelData.itinerary);
                pushIfChanged('budget', orig.budget, travelData.budget);
            } else {
                // No baseline captured — persist the budget the approver just entered.
                fieldChanges.push({ fieldName: 'budget', oldValue: null, newValue: travelData.budget });
            }
            // Always refresh the derived grand total alongside the budget.
            fieldChanges.push({ fieldName: 'grandTotal', oldValue: orig ? calculateGrandTotal() : null, newValue: calculateGrandTotal() });

            const response = await fetch(`/api/requests/${editRequestId}/approver-edit`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fieldChanges }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save changes');
            }

            router.push(`/requests/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save changes');
        } finally {
            setLoading(false);
        }
    };

    // Handle draft owner save (edit mode)
    const handleDraftSave = async () => {
        setSavingDraft(true);
        setError(null);

        try {
            const approversArray = [selectedApprovers.line_manager, selectedApprovers.functional_head, selectedApprovers.hrd, selectedApprovers.ceo].filter(Boolean);
            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Travel Auth: ${travelData.purposeOfTravel?.substring(0, 50) || 'Draft'}`,
                    description: travelData.purposeOfTravel || 'Draft request',
                    metadata: {
                        type: travelRequestType,
                        isInternational,
                        dateOfIntendedTravel: travelData.dateOfIntendedTravel,
                        purposeOfTravel: travelData.purposeOfTravel,
                        accompanyingAssociates: travelData.accompanyingAssociates,
                        travelMode: travelData.travelMode,
                        acceptConditions: travelData.acceptConditions,
                        itinerary: travelData.itinerary,
                        budget: travelData.budget,
                        grandTotal: calculateGrandTotal(),
                        costAllocation: finalizeCostAllocation(),
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                    },
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save draft');
            }

            router.push(`/requests/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const [showPreview, setShowPreview] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const travelModeLabel = (code: string) => {
        switch (code) {
            case 'personal_motor_vehicle': return 'Personal Motor Vehicle';
            case 'air_transport': return 'Air Transport';
            case 'bus_public_transport': return 'Bus / Public Transport';
            default: return '—';
        }
    };

    const locationLabel = (code: string, custom?: string) => {
        // For international travel (no code, only custom city), fall back to the typed-in value.
        if (!code) return custom || '—';
        if (code === 'OTHER') return custom || 'Other';
        const loc = TRAVEL_LOCATIONS.find(l => l.code === code);
        return loc ? loc.name : code;
    };

    const travelModeText = () => {
        const base = travelModeLabel(travelData.travelMode);
        if (travelData.travelMode === 'personal_motor_vehicle' && travelData.vehicleRegistration) {
            return `${base} — Reg: ${travelData.vehicleRegistration}`;
        }
        return base;
    };

    // Shared inline styles so the preview and the printed HTML look the same.
    const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11 };
    const cellStyle: React.CSSProperties = { border: '1px solid #333', padding: '6px 8px', verticalAlign: 'top' };
    const headCellStyle: React.CSSProperties = { ...cellStyle, background: '#F3EADC', color: '#5E4426', fontWeight: 700, textAlign: 'left' };
    const labelCellStyle: React.CSSProperties = { ...cellStyle, background: '#FAF7F0', fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em', width: '28%' };

    // Pre-submission preview: hand off to the shared builder so the document
    // layout stays identical to what the user will see on the [id] detail
    // page after submission. Keep the local builder as a thin adapter that
    // pulls values out of form state.
    const buildPreviewSections = (): PreviewSection[] => {
        const requestTimestamp = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });

        // Map the four approval-role keys to the currently selected user names.
        const approverDisplay: Record<string, { name?: string }> = {};
        for (const r of approvalRoles) {
            const u = users.find(u => u.id === selectedApprovers[r.key]);
            approverDisplay[r.key] = { name: u?.display_name };
        }

        // Filing on behalf of a principal: the document must read as if the
        // principal filled it themselves — their name/department/business unit go
        // on the header (see requestor* derivations above), and the conditions
        // block shows the acceptance checkbox only, with no signature, because
        // the principal never personally signed. When filing for oneself, the
        // current user's own signature renders as before.
        return buildTravelAuthPreviewSections({
            employee: {
                name: requestorName,
                department: requestorDepartment,
                businessUnit: requestorBusinessUnit,
            },
            requestTimestamp,
            dateOfIntendedTravel: travelData.dateOfIntendedTravel,
            purposeOfTravel: travelData.purposeOfTravel,
            accompanyingAssociates: travelData.accompanyingAssociates,
            travelMode: travelData.travelMode,
            vehicleRegistration: travelData.vehicleRegistration,
            isInternational,
            isEmergencyRequest,
            emergencyReason,
            acceptConditions: travelData.acceptConditions,
            travellerName: requestorName,
            travellerSignatureUrl: isOnBehalf
                ? null
                : (user?.id ? `/api/signature/view?userId=${encodeURIComponent(user.id)}` : null),
            onBehalf: isOnBehalf,
            itinerary: travelData.itinerary,
            budget: travelData.budget,
            grandTotal: calculateGrandTotal(),
            costAllocation: finalizeCostAllocation(),
            approvers: approverDisplay,
        });
    };

    const travelDocumentHeader: DocumentHeader = buildTravelAuthDocumentHeader(isInternational);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // If approver editing, use approver save
        if (isApproverEditing && isEditMode) {
            await handleApproverSave();
            return;
        }

        // If editing a draft, use draft save
        if (isEditMode && !isApproverEditing) {
            await handleDraftSave();
            return;
        }

        setShowConfirm(true);
    };

    const performSubmit = async () => {
        setLoading(true);
        setError(null);

        const errors = validateForm();
        if (errors.length > 0) {
            setError(errors.join('. '));
            setLoading(false);
            return;
        }

        try {
            const approversArray = [selectedApprovers.line_manager, selectedApprovers.functional_head, selectedApprovers.hrd, selectedApprovers.ceo].filter(Boolean);
            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `${isInternational ? 'Intl Travel' : 'Travel'} Auth: ${travelData.purposeOfTravel.substring(0, 50)}`,
                    description: travelData.purposeOfTravel,
                    priority: 'normal',
                    category: 'travel',
                    requestType: travelRequestType,
                    status: 'pending',
                    metadata: {
                        type: travelRequestType,
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        isInternational,
                        dateOfIntendedTravel: travelData.dateOfIntendedTravel,
                        purposeOfTravel: travelData.purposeOfTravel,
                        accompanyingAssociates: travelData.accompanyingAssociates,
                        travelMode: travelData.travelMode,
                        acceptConditions: travelData.acceptConditions,
                        itinerary: travelData.itinerary,
                        budget: travelData.budget,
                        grandTotal: calculateGrandTotal(),
                        costAllocation: finalizeCostAllocation(),
                        isEmergencyRequest: isTravelWithin7Days() ? isEmergencyRequest : false,
                        emergencyReason: isTravelWithin7Days() && isEmergencyRequest ? emergencyReason : '',
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                    },
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to create travel authorization');
            await uploadSupportingDocuments(data.request.id, supportingDocs);
            router.push(`/requests/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to create travel authorization');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveDraft = async () => {
        setSavingDraft(true);
        setError(null);
        try {
            const approversArray = [selectedApprovers.line_manager, selectedApprovers.functional_head, selectedApprovers.hrd, selectedApprovers.ceo].filter(Boolean);
            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `${isInternational ? 'Intl Travel' : 'Travel'} Auth: ${travelData.purposeOfTravel?.substring(0, 50) || 'Draft'}`,
                    description: travelData.purposeOfTravel || 'Draft request',
                    priority: 'normal',
                    category: 'travel',
                    requestType: travelRequestType,
                    status: 'draft',
                    metadata: {
                        type: travelRequestType,
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        isInternational,
                        dateOfIntendedTravel: travelData.dateOfIntendedTravel,
                        purposeOfTravel: travelData.purposeOfTravel,
                        accompanyingAssociates: travelData.accompanyingAssociates,
                        travelMode: travelData.travelMode,
                        isEmergencyRequest: isTravelWithin7Days() ? isEmergencyRequest : false,
                        emergencyReason: isTravelWithin7Days() && isEmergencyRequest ? emergencyReason : '',
                        acceptConditions: travelData.acceptConditions,
                        itinerary: travelData.itinerary,
                        budget: travelData.budget,
                        grandTotal: calculateGrandTotal(),
                        costAllocation: finalizeCostAllocation(),
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                    },
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to save draft');
            router.push(`/requests/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    const unsavedPrompt = useUnsavedChangesPrompt({
        isDirty,
        disabled: loading || savingDraft,
    });

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Travel Authorization" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    const pageTitle = isApproverEditing ? `Edit ${formKindLabel} (Approver)` : isEditMode ? `Edit ${formKindLabel}` : formKindLabel;

    return (
        <AppLayout title={pageTitle} showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        {isApproverEditing ? `Edit ${formKindLabel}` : formKindLabel}
                    </h1>
                    <p className="text-xs text-gray-500 mt-1">{isInternational ? 'DOC NO: HR APX – 27 INTERNATIONAL TRAVEL AUTHORISATION' : 'DOC NO: HR APX – 27 LOCAL TRAVEL AUTHORISATION'}</p>
                    <div className="mt-4 max-w-lg mx-auto">
                        <ReferenceCodeBanner
                            requestType={travelRequestType}
                            existingCode={existingReferenceCode}
                            onCodeAssigned={setReferenceCode}
                        />
                    </div>
                    {isApproverEditing && (
                        <div className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-primary-50 border border-primary-200 rounded-xl">
                            <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                            <span className="text-sm font-medium text-primary-700">Editing as Approver - Changes will be tracked</span>
                        </div>
                    )}
                </div>

                {error && <Card className="mb-4 bg-danger-50 border-danger-200"><p className="text-danger-600 text-sm">{error}</p></Card>}

                <div className="space-y-6">
                    {/* Filing on behalf of — shown at the top; only assigned assistants see it */}
                    <Card className="p-6">
                        <OnBehalfOfField value={onBehalfOf} onChange={setOnBehalfOf} disabled={isApproverEditing} />
                    </Card>

                    {/* Requestor Information — when filing on behalf of a principal,
                        this section shows THAT person's details (name, business unit,
                        department), autofilled the moment they're selected above, so
                        the form reads as if they filled it themselves. */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Requestor Information</h3>
                        {isOnBehalf && (
                            <p className="text-xs text-primary-700 bg-primary-50 border border-primary-200 rounded-lg px-3 py-2 mb-4">
                                Showing details for <strong>{onBehalfOf?.name}</strong>, on whose behalf you are filing this request.
                            </p>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Name</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestorName || ((isOnBehalf ? onBehalfProfileLoading : hrimsLoading)
                                        ? <span className="inline-block h-4 w-32 bg-gray-200 rounded animate-pulse align-middle" />
                                        : '—')}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Business Unit</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestorBusinessUnit || ((isOnBehalf ? onBehalfProfileLoading : hrimsLoading)
                                        ? <span className="inline-block h-4 w-24 bg-gray-200 rounded animate-pulse align-middle" />
                                        : '—')}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Department</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestorDepartment || ((isOnBehalf ? onBehalfProfileLoading : hrimsLoading)
                                        ? <span className="inline-block h-4 w-28 bg-gray-200 rounded animate-pulse align-middle" />
                                        : '—')}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Date</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">{today}</div>
                            </div>
                        </div>
                    </Card>

                    {/* Travel Details */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Travel Details</h3>
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <Input
                                    type="date"
                                    label="Date of Intended Travel *"
                                    value={travelData.dateOfIntendedTravel}
                                    onChange={(e) => {
                                        const newDate = e.target.value;
                                        setTravelData(prev => ({
                                            ...prev,
                                            dateOfIntendedTravel: newDate,
                                            // Auto-fill the itinerary date for any row that hasn't been
                                            // manually set, OR rows that were previously synced to the
                                            // old intended date. This keeps the itinerary in sync as
                                            // the user revises the travel date without overwriting any
                                            // dates the user explicitly typed.
                                            itinerary: prev.itinerary.map(row => {
                                                const previouslySynced = !row.date || row.date === prev.dateOfIntendedTravel;
                                                return previouslySynced ? { ...row, date: newDate } : row;
                                            }),
                                        }));
                                    }}
                                    required
                                    min={todayISO}
                                />
                                <div><label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Purpose of Travel <span className="text-danger-500">*</span></label><textarea className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]" value={travelData.purposeOfTravel} onChange={(e) => setTravelData({ ...travelData, purposeOfTravel: e.target.value })} placeholder="Enter purpose of travel" required /></div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div><label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Accompanying Associates</label><textarea className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]" value={travelData.accompanyingAssociates} onChange={(e) => setTravelData({ ...travelData, accompanyingAssociates: e.target.value })} placeholder="Enter names of accompanying associates (if any)" /></div>
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Travel Mode <span className="text-danger-500">*</span></label>
                                    <select
                                        value={travelData.travelMode}
                                        onChange={(e) => setTravelData({ ...travelData, travelMode: e.target.value })}
                                        className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                                        required
                                    >
                                        <option value="">Select Travel Mode</option>
                                        <option value="personal_motor_vehicle">Personal Motor Vehicle</option>
                                        <option value="air_transport">Air Transport</option>
                                        <option value="bus_public_transport">Bus / Public Transport</option>
                                    </select>
                                </div>
                            </div>
                            {/* Vehicle Registration - only for Personal Motor Vehicle */}
                            {travelData.travelMode === 'personal_motor_vehicle' && (
                                <div className="mt-4">
                                    <Input
                                        label="Vehicle Registration Number *"
                                        value={travelData.vehicleRegistration || ''}
                                        onChange={(e) => setTravelData({ ...travelData, vehicleRegistration: e.target.value })}
                                        placeholder="e.g., ABC 1234"
                                        required
                                    />
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Emergency Request Warning - Shows when travel is within 7 days */}
                    {isTravelWithin7Days() && (
                        <Card className="p-6 bg-red-50 border-2 border-red-300">
                            <div className="flex items-start gap-3 mb-4">
                                <svg className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <div>
                                    <h4 className="font-bold text-red-800 uppercase text-sm">Emergency Travel Request Required</h4>
                                    <p className="text-sm text-red-700 mt-1">
                                        Your travel date is within 7 days. Per company policy, authorization must be sought at least 7 days prior to departure. 
                                        To proceed, you must flag this as an emergency request and provide a valid reason.
                                    </p>
                                </div>
                            </div>
                            <div className="space-y-4 bg-white rounded-xl p-4 border border-red-200">
                                <div className="flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        id="isEmergencyRequest"
                                        checked={isEmergencyRequest}
                                        onChange={(e) => setIsEmergencyRequest(e.target.checked)}
                                        className="w-5 h-5 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                                    />
                                    <label htmlFor="isEmergencyRequest" className="text-sm font-semibold text-red-800 cursor-pointer">
                                        I confirm this is an emergency travel request <span className="text-red-600">*</span>
                                    </label>
                                </div>
                                {isEmergencyRequest && (
                                    <div>
                                        <label className="block text-sm font-semibold text-red-800 mb-1 uppercase">
                                            Reason for Emergency Travel <span className="text-red-600">*</span>
                                        </label>
                                        <textarea
                                            className="w-full px-4 py-2 rounded-xl border border-red-300 focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none transition-all resize-none min-h-[80px]"
                                            value={emergencyReason}
                                            onChange={(e) => setEmergencyReason(e.target.value)}
                                            placeholder="Please explain why this travel request could not be submitted 7 days in advance..."
                                            required
                                        />
                                    </div>
                                )}
                            </div>
                        </Card>
                    )}

                    {/* Conditions */}
                    <Card className="p-6 bg-amber-50 border border-amber-200">
                        <h4 className="font-semibold text-amber-800 mb-3 uppercase text-sm">Conditions of Travel</h4>
                        <ol className="list-decimal list-inside space-y-2 text-sm text-amber-900">
                            <li>Authorization must be sought using this form at least 7 days prior to departure.</li>
                            <li>Travel expenses must be claimed within 30 days after completion of travel, otherwise the claim shall be void.</li>
                            <li>It is an act of misconduct to travel without authority.</li>
                        </ol>
                        <div className="mt-4 flex items-center gap-3">
                            <input type="checkbox" id="acceptConditions" checked={travelData.acceptConditions} onChange={(e) => setTravelData({ ...travelData, acceptConditions: e.target.checked })} className="w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded" required />
                            <label htmlFor="acceptConditions" className="text-sm font-medium text-amber-900 cursor-pointer">I have read these conditions and accept them. <span className="text-danger-500">*</span></label>
                        </div>
                    </Card>

                    {/* Travel Itinerary */}
                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-3">
                            <h4 className="font-semibold text-gray-700 uppercase text-sm">Travel Itinerary <span className="text-danger-500">*</span></h4>
                            <button type="button" onClick={addItineraryRow} className="text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>Add Row
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-gray-100">
                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Date/Time</th>
                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">From</th>
                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">To</th>
                                        {!isInternational && (
                                            <th className="px-3 py-2 text-left font-semibold text-gray-700 w-20">KM</th>
                                        )}
                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Justification</th>
                                        <th className="px-3 py-2 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {travelData.itinerary.map((row, index) => {
                                        const isFromOther = row.from === 'OTHER';
                                        const isToOther = row.to === 'OTHER';
                                        // In international mode the user always enters origin/destination and km manually.
                                        const isManualEntry = isInternational || isFromOther || isToOther;
                                        return (
                                            <tr key={index} className="border-b border-gray-100">
                                                <td className="px-2 py-2">
                                                    <input type="date" value={row.date} onChange={(e) => updateItineraryRow(index, 'date', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" />
                                                </td>
                                                <td className="px-2 py-2">
                                                    <div className="space-y-1">
                                                        {isInternational ? (
                                                            <input type="text" value={row.fromCustom || ''} onChange={(e) => updateItineraryRow(index, 'fromCustom', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="Origin city / country" />
                                                        ) : (
                                                            <>
                                                                <select value={row.from} onChange={(e) => updateItineraryRow(index, 'from', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm">
                                                                    <option value="">Select Origin</option>
                                                                    {TRAVEL_LOCATIONS.map(loc => (
                                                                        <option key={loc.code} value={loc.code}>{loc.name}</option>
                                                                    ))}
                                                                </select>
                                                                {isFromOther && (
                                                                    <input type="text" value={row.fromCustom || ''} onChange={(e) => updateItineraryRow(index, 'fromCustom', e.target.value)} className="w-full px-2 py-1 rounded border border-orange-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm bg-orange-50" placeholder="Enter custom origin" />
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-2 py-2">
                                                    <div className="space-y-1">
                                                        {isInternational ? (
                                                            <input type="text" value={row.toCustom || ''} onChange={(e) => updateItineraryRow(index, 'toCustom', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="Destination city / country" />
                                                        ) : (
                                                            <>
                                                                <select value={row.to} onChange={(e) => updateItineraryRow(index, 'to', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm">
                                                                    <option value="">Select Destination</option>
                                                                    {TRAVEL_LOCATIONS.map(loc => (
                                                                        <option key={loc.code} value={loc.code}>{loc.name}</option>
                                                                    ))}
                                                                </select>
                                                                {isToOther && (
                                                                    <input type="text" value={row.toCustom || ''} onChange={(e) => updateItineraryRow(index, 'toCustom', e.target.value)} className="w-full px-2 py-1 rounded border border-orange-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm bg-orange-50" placeholder="Enter custom destination" />
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                                {!isInternational && (
                                                    <td className="px-2 py-2">
                                                        <input type="number" value={row.km} readOnly={!isManualEntry} onChange={(e) => isManualEntry && updateItineraryRow(index, 'km', e.target.value)} className={`w-full px-2 py-1 rounded border outline-none text-sm text-center font-medium ${isManualEntry ? 'border-orange-300 bg-orange-50 focus:ring-1 focus:ring-orange-500' : 'border-gray-200 bg-gray-50'}`} placeholder="0" />
                                                    </td>
                                                )}
                                                <td className="px-2 py-2">
                                                    <input type="text" value={row.justification} onChange={(e) => updateItineraryRow(index, 'justification', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="Reason" />
                                                </td>
                                                <td className="px-2 py-2">
                                                    {travelData.itinerary.length > 1 && (
                                                        <button type="button" onClick={() => removeItineraryRow(index)} className="text-red-500 hover:text-red-700">
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    {!isInternational && (
                                        <tr className="bg-primary-50 font-semibold">
                                            <td colSpan={3} className="px-3 py-2 text-right text-primary-700">Total Distance:</td>
                                            <td className="px-2 py-2 text-center text-primary-900">{travelData.itinerary.reduce((sum, row) => sum + (parseFloat(row.km) || 0), 0)} km</td>
                                            <td colSpan={2}></td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </Card>

                    {/* AA Rates Calculator - Only for Personal Motor Vehicle */}
                    {travelData.travelMode === 'personal_motor_vehicle' && (
                        <Card className="p-6 bg-[#F3EADC] border border-[#C9B896]">
                            <div className="flex items-center gap-2 mb-4">
                                <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                </svg>
                                <h4 className="font-semibold text-[#3F2D19] uppercase text-sm">Travel Cost Calculator</h4>
                            </div>
                            <p className="text-sm text-[#5E4426] mb-4">Select your vehicle details to calculate travel cost using AA rates.</p>

                            <div className="bg-white rounded-xl p-4 border border-[#C9B896] space-y-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle Engine Size <span className="text-danger-500">*</span></label>
                                        <select
                                            value={aaCalculator.engineCapacity}
                                            onChange={(e) => setAACalculator({ ...aaCalculator, engineCapacity: e.target.value })}
                                            className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-[#9A7545] focus:border-transparent outline-none text-sm"
                                        >
                                            <option value="1.1L-1.5L">1.1L – 1.5L</option>
                                            <option value="1.6L-2.0L">1.6L – 2.0L</option>
                                            <option value="2.1L-3.0L">2.1L – 3.0L</option>
                                            <option value="Above 3.0L">Above 3.0L</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Fuel Type <span className="text-danger-500">*</span></label>
                                        <select
                                            value={aaCalculator.fuelType}
                                            onChange={(e) => setAACalculator({ ...aaCalculator, fuelType: e.target.value as 'petrol' | 'diesel' })}
                                            className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-[#9A7545] focus:border-transparent outline-none text-sm"
                                        >
                                            <option value="petrol">Petrol</option>
                                            <option value="diesel">Diesel</option>
                                        </select>
                                    </div>
                                </div>

                                {/* Rate Display */}
                                <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <span className="text-gray-500 text-sm block">AA Rate per km</span>
                                            <span className="font-bold text-[#3F2D19] text-xl">USD {getAARate().toFixed(2)}</span>
                                        </div>
                                        <div className="text-right">
                                            <span className="text-gray-500 text-sm block">Total Distance</span>
                                            <span className="font-bold text-gray-800 text-xl">{travelData.itinerary.reduce((sum, row) => sum + (parseFloat(row.km) || 0), 0)} km</span>
                                        </div>
                                        <div className="text-right bg-[#F3EADC] rounded-lg p-3">
                                            <span className="text-[#5E4426] text-sm block font-medium">Estimated Travel Cost</span>
                                            <span className="font-bold text-[#3F2D19] text-xl">USD {(travelData.itinerary.reduce((sum, row) => sum + (parseFloat(row.km) || 0), 0) * getAARate()).toFixed(2)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* AA Rate Reference Table */}
                                <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
                                    <h5 className="font-medium text-gray-700 mb-2 text-xs uppercase">AA Rate Reference (USD/km)</h5>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="border-b border-gray-200">
                                                    <th className="text-left py-1 px-2 font-medium text-gray-600">Engine Capacity</th>
                                                    <th className="text-center py-1 px-2 font-medium text-gray-600">Petrol</th>
                                                    <th className="text-center py-1 px-2 font-medium text-gray-600">Diesel</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {([
                                                    ['1.1L-1.5L', '1.1L – 1.5L'],
                                                    ['1.6L-2.0L', '1.6L – 2.0L'],
                                                    ['2.1L-3.0L', '2.1L – 3.0L'],
                                                    ['Above 3.0L', 'Above 3.0L'],
                                                ] as const).map(([key, label], idx, arr) => (
                                                    <tr key={key} className={`${idx < arr.length - 1 ? 'border-b border-gray-100 ' : ''}${aaCalculator.engineCapacity === key ? 'bg-[#F3EADC]' : ''}`}>
                                                        <td className="py-1 px-2">{label}</td>
                                                        <td className={`text-center py-1 px-2 ${aaCalculator.engineCapacity === key && aaCalculator.fuelType === 'petrol' ? 'font-bold text-[#5E4426]' : ''}`}>{(aaRates[key]?.petrol ?? 0).toFixed(2)}</td>
                                                        <td className={`text-center py-1 px-2 ${aaCalculator.engineCapacity === key && aaCalculator.fuelType === 'diesel' ? 'font-bold text-[#5E4426]' : ''}`}>{(aaRates[key]?.diesel ?? 0).toFixed(2)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                <p className="text-xs text-[#5E4426] mt-4 flex items-center gap-1.5">
                                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    This travel cost is added to your budget automatically from the itinerary distance and the rate above.
                                </p>
                            </div>
                        </Card>
                    )}

                    {/* Travel Budget */}
                    <Card className="p-6">
                        <h4 className="font-semibold text-gray-700 uppercase text-sm mb-3">Travel Budget <span className="text-danger-500">*</span></h4>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead><tr className="bg-gray-100"><th className="px-3 py-2 text-left font-semibold text-gray-700">Expenditure Item</th><th className="px-3 py-2 text-left font-semibold text-gray-700 w-24">Quantity</th><th className="px-3 py-2 text-left font-semibold text-gray-700 w-28">Unit Cost (USD)</th><th className="px-3 py-2 text-left font-semibold text-gray-700 w-28">Total Cost (USD)</th></tr></thead>
                                <tbody>
                                    {travelData.travelMode === 'personal_motor_vehicle' && (
                                        <tr className="border-b border-gray-100 bg-[#F3EADC]/40">
                                            <td className="px-3 py-2 text-gray-700">
                                                Travel Cost (AA Rate × Distance)
                                                <span className="ml-2 text-xs text-[#9A7545] font-medium">(auto-calculated)</span>
                                            </td>
                                            <td className="px-2 py-2">
                                                <input type="number" value={travelData.budget.aaRates.quantity} readOnly className="w-full px-2 py-1 rounded border border-[#C9B896] bg-[#F3EADC]/40 text-[#5E4426] font-medium outline-none text-sm" placeholder="0" />
                                            </td>
                                            <td className="px-2 py-2">
                                                <input type="number" value={travelData.budget.aaRates.unitCost} readOnly className="w-full px-2 py-1 rounded border border-[#C9B896] bg-[#F3EADC]/40 text-[#5E4426] font-medium outline-none text-sm" placeholder="0.32" />
                                            </td>
                                            <td className="px-2 py-2">
                                                <input type="number" value={travelData.budget.aaRates.totalCost} readOnly className="w-full px-2 py-1 rounded border border-[#C9B896] bg-[#F3EADC]/40 text-[#5E4426] font-medium outline-none text-sm" placeholder="0.00" />
                                            </td>
                                        </tr>
                                    )}
                                    <tr className="border-b border-gray-100"><td className="px-3 py-2 text-gray-700">Air/Bus Tickets</td><td className="px-2 py-2"><input type="number" value={travelData.budget.airBusTickets.quantity} onChange={(e) => updateBudgetItem('airBusTickets', 'quantity', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="0" min="0" /></td><td className="px-2 py-2"><input type="number" value={travelData.budget.airBusTickets.unitCost} onChange={(e) => updateBudgetItem('airBusTickets', 'unitCost', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="0.00" step="0.01" min="0" /></td><td className="px-2 py-2"><input type="number" value={travelData.budget.airBusTickets.totalCost} readOnly className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm" placeholder="0.00" /></td></tr>
                                    <tr className="border-b border-gray-100"><td className="px-3 py-2 text-gray-700">Conferencing Cost</td><td className="px-2 py-2"><input type="number" value={travelData.budget.conferencingCost.quantity} onChange={(e) => updateBudgetItem('conferencingCost', 'quantity', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="0" min="0" /></td><td className="px-2 py-2"><input type="number" value={travelData.budget.conferencingCost.unitCost} onChange={(e) => updateBudgetItem('conferencingCost', 'unitCost', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="0.00" step="0.01" min="0" /></td><td className="px-2 py-2"><input type="number" value={travelData.budget.conferencingCost.totalCost} readOnly className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm" placeholder="0.00" /></td></tr>
                                    {/* Miscellaneous Costs — free multi-line list, shown before tollgates */}
                                    <tr className="bg-gray-50 border-b border-gray-200">
                                        <td className="px-3 py-2 text-gray-700 font-medium" colSpan={3}>Miscellaneous Costs</td>
                                        <td className="px-2 py-2 text-right">
                                            <button type="button" onClick={addMiscRow} className="text-xs text-primary-600 hover:text-primary-700 font-medium inline-flex items-center gap-1">
                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
                                                Add Line
                                            </button>
                                        </td>
                                    </tr>
                                    {(Array.isArray(travelData.budget.miscCosts) ? travelData.budget.miscCosts : []).map((misc, idx) => (
                                        <tr key={idx} className="border-b border-gray-100">
                                            <td className="px-2 py-2"><input type="text" value={misc.description || ''} onChange={(e) => updateMiscRow(idx, 'description', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="Description (e.g. Visa fees)" /></td>
                                            <td className="px-2 py-2"><input type="number" value={misc.quantity} onChange={(e) => updateMiscRow(idx, 'quantity', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="0" min="0" /></td>
                                            <td className="px-2 py-2"><input type="number" value={misc.unitCost} onChange={(e) => updateMiscRow(idx, 'unitCost', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" placeholder="0.00" step="0.01" min="0" /></td>
                                            <td className="px-2 py-2 flex items-center gap-1">
                                                <input type="number" value={misc.totalCost} readOnly className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm" placeholder="0.00" />
                                                <button type="button" onClick={() => removeMiscRow(idx)} className="text-red-500 hover:text-red-700 p-1" aria-label="Remove line">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {/* Tollgates Section - Only for Personal Motor Vehicle */}
                                    {travelData.travelMode === 'personal_motor_vehicle' && (
                                        <>
                                            <tr className="bg-orange-50 border-b border-orange-200">
                                                <td className="px-3 py-3 text-orange-800 font-medium" colSpan={4}>
                                                    <div className="flex items-center justify-between flex-wrap gap-2">
                                                        <div className="flex items-center gap-3 flex-wrap">
                                                            <span className="font-semibold">Tollgates</span>
                                                            <div className="flex items-center gap-2 text-xs">
                                                                <label className="flex items-center gap-1 cursor-pointer">
                                                                    <input
                                                                        type="radio"
                                                                        name="tollgateRouteType"
                                                                        value="premium"
                                                                        checked={tollgateRouteType === 'premium'}
                                                                        onChange={(e) => setTollgateRouteType(e.target.value as TollgateRouteType)}
                                                                        className="text-orange-600 focus:ring-orange-500"
                                                                    />
                                                                    <span>Premium ($4)</span>
                                                                </label>
                                                                <label className="flex items-center gap-1 cursor-pointer">
                                                                    <input
                                                                        type="radio"
                                                                        name="tollgateRouteType"
                                                                        value="standard"
                                                                        checked={tollgateRouteType === 'standard'}
                                                                        onChange={(e) => setTollgateRouteType(e.target.value as TollgateRouteType)}
                                                                        className="text-orange-600 focus:ring-orange-500"
                                                                    />
                                                                    <span>Standard ($3)</span>
                                                                </label>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={autoCalculateTollgates}
                                                                className="text-xs bg-orange-600 text-white hover:bg-orange-700 px-3 py-1.5 rounded-lg font-medium flex items-center gap-1 transition-colors"
                                                            >
                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                                                Auto-Calculate from Itinerary
                                                            </button>
                                                        </div>
                                                        <button type="button" onClick={addTollgateRow} className="text-xs text-orange-600 hover:text-orange-700 font-medium flex items-center gap-1">
                                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
                                                            Add Tollgate
                                                        </button>
                                                    </div>
                                                    {/* Tollgate route summary */}
                                                    {getTollgateSummary().length > 0 && (
                                                        <div className="mt-2 text-xs text-orange-700 bg-orange-100/50 rounded-lg px-2 py-1.5">
                                                            <span className="font-medium">Available routes:</span> {getTollgateSummary().join('; ')}
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                            {(Array.isArray(travelData.budget.tollgates) ? travelData.budget.tollgates : []).map((toll, idx) => (
                                                <tr key={idx} className="border-b border-gray-100 bg-orange-50/30">
                                                    <td className="px-2 py-2">
                                                        <input type="text" value={toll.road} onChange={(e) => updateTollgateRow(idx, 'road', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm" placeholder="Road/Route name" />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input type="number" value={toll.quantity} onChange={(e) => updateTollgateRow(idx, 'quantity', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm" placeholder="1" min="1" />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input type="number" value={toll.unitCost} onChange={(e) => updateTollgateRow(idx, 'unitCost', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm" placeholder="0.00" step="0.01" min="0" />
                                                    </td>
                                                    <td className="px-2 py-2 flex items-center gap-1">
                                                        <input type="number" value={toll.totalCost} readOnly className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm" placeholder="0.00" />
                                                        {(Array.isArray(travelData.budget.tollgates) ? travelData.budget.tollgates : []).length > 1 && (
                                                            <button type="button" onClick={() => removeTollgateRow(idx)} className="text-red-500 hover:text-red-700 p-1">
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </>
                                    )}
                                    <tr className="bg-gray-100 font-semibold"><td className="px-3 py-2 text-gray-900" colSpan={3}>GRAND TOTAL</td><td className="px-3 py-2 text-gray-900">USD {calculateGrandTotal()}</td></tr>
                                </tbody>
                            </table>
                        </div>

                        {/* Cost Allocation — the requestor ticks the unit(s) that
                            carry the cost. One unit → whole cost. Tick 2+ to split,
                            which reveals figure inputs + a "fully allocated" control. */}
                        {!isInternational && (
                        <div className="mt-6 pt-6 border-t border-gray-200">
                            <h4 className="font-semibold text-gray-700 uppercase text-sm mb-1">Allocation Cost to Unit</h4>
                            <p className="text-xs text-gray-500 mb-3">
                                Tick the business unit that carries this cost. Tick more than one to split the cost —
                                then enter each amount so the full total is allocated.
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {ALLOCATION_UNITS.map((u) => {
                                    const selected = u.code in costAllocation;
                                    return (
                                        <div key={u.code} className={`flex items-center gap-2 p-2 rounded-lg border ${selected ? 'border-primary-300 bg-primary-50/40' : 'border-gray-200'}`}>
                                            <input
                                                type="checkbox"
                                                checked={selected}
                                                disabled={isApproverEditing}
                                                onChange={(e) => {
                                                    setCostAllocation((prev) => {
                                                        const next = { ...prev };
                                                        if (e.target.checked) next[u.code] = '';
                                                        else delete next[u.code];
                                                        return next;
                                                    });
                                                    setIsDirty(true);
                                                }}
                                                className="rounded border-gray-300"
                                            />
                                            <label className="flex-1 text-sm text-gray-700 min-w-0">
                                                <span className="font-medium">{u.code}</span>
                                                <span className="text-gray-400 text-xs block truncate">{u.label}</span>
                                            </label>
                                            {/* Split mode: enter this unit's share. Single unit: show full total. */}
                                            {selected && isSplitAllocation ? (
                                                <div className="relative w-28 flex-shrink-0">
                                                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        min="0"
                                                        inputMode="decimal"
                                                        disabled={isApproverEditing}
                                                        value={costAllocation[u.code]}
                                                        placeholder="0.00"
                                                        onChange={(e) => {
                                                            const v = e.target.value;
                                                            setCostAllocation((prev) => ({ ...prev, [u.code]: v }));
                                                            setIsDirty(true);
                                                        }}
                                                        className="w-full pl-5 pr-2 py-1.5 rounded-lg border border-gray-300 text-sm text-right focus:outline-none focus:ring-1 focus:ring-primary-500"
                                                    />
                                                </div>
                                            ) : selected ? (
                                                <span className="w-28 flex-shrink-0 text-right text-xs font-medium text-primary-700">
                                                    USD {allocationGrandTotal.toFixed(2)}
                                                </span>
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                            {/* Split control — every cent must be allocated. */}
                            {isSplitAllocation && (
                                <div className={`mt-3 flex flex-wrap items-center justify-between gap-2 text-sm px-3 py-2 rounded-lg border ${allocationFullyAllocated ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                                    <span>Allocated <strong>USD {allocationEnteredTotal.toFixed(2)}</strong> of USD {allocationGrandTotal.toFixed(2)}</span>
                                    <span className="font-medium">
                                        {allocationFullyAllocated
                                            ? 'Fully allocated ✓'
                                            : `USD ${Math.abs(allocationRemaining).toFixed(2)} ${allocationRemaining > 0 ? 'remaining' : 'over-allocated'}`}
                                    </span>
                                </div>
                            )}
                        </div>
                        )}
                    </Card>

                    {/* Supporting documents (file + label + description) */}
                    <Card className="p-6">
                        <SupportingDocuments
                            documents={supportingDocs}
                            onChange={setSupportingDocs}
                            disabled={isApproverEditing}
                        />
                    </Card>

                    {/* Approval Section */}
                    <Card className="p-6">
                        <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
                            <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            Approval Workflow <span className="text-danger-500">*</span>
                        </h3>
                        <p className="text-sm text-text-secondary mb-4">Approvers are automatically assigned from the HRIMS organogram. If a role has no assigned user, you must manually select one.</p>

                        {showApproverDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowApproverDropdown(null)} />}

                        {loadingApproverResolution ? (
                            <ApproverSectionLoader rows={approvalRoles.length} />
                        ) : (
                        <div className="space-y-4">
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);
                                const isAutoResolved = autoResolvedRoles[role.key];
                                const isLocked = isApproverRowLocked(role.key, isAutoResolved);

                                return (
                                    <div key={role.key} className="relative">
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1"><span className="font-bold text-sm">{index + 1}</span></div>
                                            <div className="flex-1">
                                                <div className="mb-2"><h4 className="font-semibold text-gray-900">{role.label}</h4><p className="text-xs text-gray-500">{role.description}</p></div>
                                                {selectedUser ? (
                                                    <div className={`flex items-center gap-3 ${isAutoResolved ? 'bg-green-50 border border-green-200' : 'bg-primary-50 border border-primary-200'} p-3 rounded-xl`}>
                                                        <div className={`w-8 h-8 rounded-full ${isAutoResolved ? 'bg-green-100' : 'bg-primary-100'} flex items-center justify-center flex-shrink-0`}><span className={`text-sm font-medium ${isAutoResolved ? 'text-green-600' : 'text-primary-600'}`}>{selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}</span></div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                                                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                                                            {isAutoResolved && <p className="text-xs text-green-600 mt-0.5">Auto-assigned from HRIMS organogram{isLocked ? ' · locked' : ''}</p>}
                                                        </div>
                                                        {/* Senior fixed approvers (CEO, HRD, directors) are locked once
                                                            auto-resolved; departmental/managerial rows stay changeable. */}
                                                        {!isLocked && (
                                                            <button type="button" onClick={() => { handleRemoveApprover(role.key); setAutoResolvedRoles(prev => ({ ...prev, [role.key]: false })); }} className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors" title="Remove approver"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg></button>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="relative">
                                                        {!loadingApproverResolution && !isEditMode && (
                                                            <p className="text-xs text-amber-600 mb-1">No user found in HRIMS for this role. Please select manually.</p>
                                                        )}
                                                        <div className="relative">
                                                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                                            <input type="text" className="w-full pl-10 pr-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all" placeholder={`Search for ${role.label}...`} value={approverSearch[role.key]} onChange={(e) => { setApproverSearch(prev => ({ ...prev, [role.key]: e.target.value })); setShowApproverDropdown(role.key); }} onFocus={() => setShowApproverDropdown(role.key)} />
                                                        </div>
                                                        {showApproverDropdown === role.key && (
                                                            <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                                                {loadingUsers ? <div className="p-3 text-center text-gray-500 text-sm">Loading users...</div> : filteredUsers.length === 0 ? <div className="p-3 text-center text-gray-500 text-sm">No users found</div> : filteredUsers.slice(0, 10).map(u => (
                                                                    <button key={u.id} type="button" onClick={() => handleSelectApprover(role.key, u.id)} className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 transition-colors text-left">
                                                                        <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0"><span className="text-sm font-medium text-gray-600">{u.display_name?.charAt(0)?.toUpperCase() || '?'}</span></div>
                                                                        <div className="flex-1 min-w-0"><p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p><p className="text-xs text-gray-500 truncate">{u.email}</p></div>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        )}
                    </Card>
                </div>

                {/* Fixed Bottom Actions */}
                <div className="sticky bottom-0 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-100 pb-safe">
                    <div className="flex gap-3 max-w-5xl mx-auto">
                        {isApproverEditing ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading}>Save Changes</Button>
                            </>
                        ) : isEditMode ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading || savingDraft}>Save Changes</Button>
                            </>
                        ) : (
                            <>
                                <Button type="button" variant="secondary" onClick={handleSaveDraft} isLoading={savingDraft} disabled={loading}>Save Draft</Button>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1" isLoading={loading} disabled={savingDraft}>Submit Authorization</Button>
                            </>
                        )}
                    </div>
                </div>
            </form>

            <RequestPreviewModal
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                mode="preview"
                title={formKindLabel}
                sections={buildPreviewSections()}
                documentHeader={travelDocumentHeader}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title={formKindLabel}
                sections={buildPreviewSections()}
                documentHeader={travelDocumentHeader}
                confirming={loading}
                onConfirm={async () => {
                    setShowConfirm(false);
                    await performSubmit();
                }}
            />
            <UnsavedChangesModal
                isOpen={unsavedPrompt.isOpen}
                savingDraft={savingDraft}
                canSaveDraft={!isApproverEditing}
                onSaveDraft={() => unsavedPrompt.saveDraftAndContinue(handleSaveDraft)}
                onDiscard={unsavedPrompt.discardAndContinue}
                onCancel={unsavedPrompt.cancel}
            />
        </AppLayout>
    );
}
