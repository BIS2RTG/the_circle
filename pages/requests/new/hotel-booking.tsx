import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal, ReferenceCodeBanner, buildDocumentHeaderSection } from '../../../components/ui';
import type { PreviewSection, DocumentHeader } from '../../../components/ui';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { useRequestorIdentity } from '../../../hooks/useRequestorIdentity';
import { calculateTollgatesForItinerary, getTollgateRouteInfo, TollgateRouteType } from '../../../lib/formConfig';
import { ALLOCATION_UNITS, buildTravelAuthPreviewSections, buildTravelAuthDocumentHeader } from '../../../lib/previews/travelAuthPreview';
import { OnBehalfOfField, type OnBehalfOf } from '../../../components/requests/OnBehalfOfField';
import { isApproverRowLocked } from '../../../lib/approverLocking';
import ApproverSectionLoader from '../../../components/requests/ApproverSectionLoader';
import { AssociatesField, type Associate } from '../../../components/requests/AssociatesField';
import { SupportingDocuments, uploadSupportingDocuments, makeSupportingDoc, type SupportingDoc } from '../../../components/requests/SupportingDocuments';

interface SelectedBusinessUnit {
    instanceId: string; // Unique ID for each booking instance (allows same hotel multiple times)
    id: string;
    name: string;
    /** HRIMS unit code (e.g. "MRC", "RTH"). Carried alongside the name so the
     *  travel-doc autofill can match this booking to the TRAVEL_LOCATIONS
     *  dropdown directly, no fuzzy string match needed. */
    code?: string;
    bookingMade: boolean;
    arrivalDate: string;
    departureDate: string;
    numberOfNights: string;
    numberOfRooms: string;
    accommodationType: string;
    specialArrangements: string;
}

interface AACalculatorData {
    engineCapacity: string;
    fuelType: 'petrol' | 'diesel';
}

interface TollgateEntry {
    road: string;
    quantity: string;
    unitCost: string;
    totalCost: string;
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
// Inter-business unit distances in KM (exact values from hotel to hotel)
// const DISTANCE_MATRIX: Record<string, Record<string, number>> = {
//     'RTH':  { 'RTH': 0,   'NAH': 2.1,   'KHCC': 139,   'BRH': 440,   'AZAM': 725,   'VFRH': 721,   'MRC': 250 },
//     'NAH':  { 'RTH': 2.1, 'NAH': 0,     'KHCC': 136.9, 'BRH': 437.9, 'AZAM': 722.9, 'VFRH': 718.9, 'MRC': 247.9 },
//     'KHCC': { 'RTH': 139, 'NAH': 140, 'KHCC': 0,     'BRH': 301,   'AZAM': 585,   'VFRH': 582,   'MRC': 389 },
//     'BRH':  { 'RTH': 439, 'NAH': 441, 'KHCC': 300,   'BRH': 0,     'AZAM': 454,   'VFRH': 450,   'MRC': 593 },
//     'AZAM': { 'RTH': 725, 'NAH': 722.9, 'KHCC': 585,   'BRH': 454,   'AZAM': 0,     'VFRH': 4,     'MRC': 973 },
//     'VFRH': { 'RTH': 721, 'NAH': 718.9, 'KHCC': 581,   'BRH': 450,   'AZAM': 4,     'VFRH': 0,     'MRC': 969 },
//     'MRC':  { 'RTH': 250, 'NAH': 247.9, 'KHCC': 389,   'BRH': 593,   'AZAM': 973,   'VFRH': 969,   'MRC': 0 },
// };

// These are from the distance table shared by THE DISTANCE TABLE
const DISTANCE_MATRIX: Record<string, Record<string, number>> = {
    'RTH':  { 'RTH': 0,   'NAH': 0,   'KHCC': 134,   'BRH': 439,   'AZAM': 876,   'VFRH': 876,   'MRC': 250 },
    'NAH':  { 'RTH': 0, 'NAH': 0, 'KHCC': 134,     'BRH': 439,   'AZAM': 876,   'VFRH': 876,   'MRC': 250 },
    'KHCC': { 'RTH': 141, 'NAH': 141, 'KHCC': 0,     'BRH': 298,   'AZAM': 735,   'VFRH': 735,   'MRC': 400 },
    'BRH':  { 'RTH': 439, 'NAH': 439, 'KHCC': 298,   'BRH': 0,     'AZAM': 437,   'VFRH': 437,   'MRC': 102 },
    'AZAM': { 'RTH': 876, 'NAH': 876, 'KHCC': 735,   'BRH': 437,   'AZAM': 0,     'VFRH': 0,     'MRC': 1123 },
    'VFRH': { 'RTH': 876, 'NAH': 876, 'KHCC': 735,   'BRH': 437,   'AZAM': 0,     'VFRH': 0,     'MRC': 1123 },
    'MRC':  { 'RTH': 250, 'NAH': 250, 'KHCC': 400,   'BRH': 102,   'AZAM': 1123,   'VFRH': 1123,   'MRC': 0 },
};

// Get distance between two locations
const getDistance = (from: string, to: string): number => {
    if (!from || !to) return 0;
    return DISTANCE_MATRIX[from]?.[to] || 0;
};

export default function HotelBookingPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName } = useUserHrimsProfile();
    const [businessUnits, setBusinessUnits] = useState<Array<{ id: string; name: string; code?: string }>>([]);
    const [businessUnitsLoading, setBusinessUnitsLoading] = useState(true);
    const [loading, setLoading] = useState(false);
    const [savingDraft, setSavingDraft] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedBusinessUnits, setSelectedBusinessUnits] = useState<SelectedBusinessUnit[]>([]);

    // Edit mode state
    const { edit: editRequestId, approver: isApproverEdit } = router.query;
    const isEditMode = !!editRequestId;
    const isApproverEditing = isApproverEdit === 'true';
    const [loadingRequest, setLoadingRequest] = useState(false);
    const [originalFormData, setOriginalFormData] = useState<any>(null);
    const [originalTravelData, setOriginalTravelData] = useState<any>(null);
    const [originalBusinessUnits, setOriginalBusinessUnits] = useState<SelectedBusinessUnit[]>([]);
    const [originalApprovers, setOriginalApprovers] = useState<Record<string, string> | null>(null);
    const [requestStatus, setRequestStatus] = useState<string>('draft');
    const [referenceCode, setReferenceCode] = useState<string | null>(null);
    const [existingReferenceCode, setExistingReferenceCode] = useState<string | null>(null);

    // Initial date for display
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Today's date in ISO format for min date validation
    const todayISO = new Date().toISOString().split('T')[0];

    const [formData, setFormData] = useState({
        guestNames: '',
        isExternalGuest: false,
        // allocationType is now set by the HR Director at approval time.
        // We keep it on the form's metadata payload (empty by default) so
        // the field still exists in the persisted document and the HRD's
        // selection has a place to land.
        allocationType: '',
        percentageDiscount: '',
        reason: '',
        processTravelDocument: false,
    });

    // Unsaved-changes tracking — flipped true on first real user interaction via form onChange.
    const [isDirty, setIsDirty] = useState(false);

    // Approver selection state - 4 fixed roles
    const approvalRoles = [
        { key: 'line_manager', label: 'Line Manager', description: 'Recommendation' },
        { key: 'functional_head', label: 'Functional Head', description: 'Functional Approval' },
        { key: 'hrd', label: 'Chief Human Capital Officer', description: 'Human Capital Approval' },
        { key: 'ceo', label: 'CEO', description: 'Authorisation' },
    ];
    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        line_manager: '',
        functional_head: '',
        hrd: '',
        ceo: '',
    });
    const [onBehalfOf, setOnBehalfOf] = useState<OnBehalfOf | null>(null);
    // Requestor identity shown on the form + document — the principal when filing
    // on behalf of someone (autofilled on selection), else the signed-in user.
    const requestor = useRequestorIdentity(onBehalfOf);

    // Travel cost allocation — the REQUESTOR ticks the business unit(s) that carry
    // the travel cost (mirrors requests/new/travel-auth). Previously this was
    // deferred to the CHCO at approval time, which was wrong. Keyed by unit code
    // (see ALLOCATION_UNITS); persisted to metadata.travelCostAllocation.
    const [costAllocation, setCostAllocation] = useState<Record<string, string>>({});
    // Accompanying associates: directory picks carry an id (→ request watchers);
    // non-RTG guests are free-text only. `formData.guestNames` is kept in sync as
    // the joined display string used in the title/metadata/preview.
    const [associates, setAssociates] = useState<Associate[]>([]);
    // Supporting documents attached to the travel authorization section.
    const [travelSupportingDocs, setTravelSupportingDocs] = useState<SupportingDoc[]>([]);
    const associateWatcherIds = associates.map((a) => a.id).filter((id): id is string => !!id);
    const handleAssociatesChange = (next: Associate[]) => {
        setAssociates(next);
        setFormData((prev) => ({ ...prev, guestNames: next.map((a) => a.name).join(', ') }));
    };
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        line_manager: '',
        functional_head: '',
        hrd: '',
        ceo: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);
    const [loadingApproverResolution, setLoadingApproverResolution] = useState(!isEditMode);
    const [autoResolvedRoles, setAutoResolvedRoles] = useState<Record<string, boolean>>({});

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

    // Calculate and apply AA rate to travel budget
    const applyAARate = () => {
        const rate = getAARate();
        const totalKm = travelData.itinerary.reduce((sum, row) => sum + (parseFloat(row.km) || 0), 0);
        const travelCost = (totalKm * rate).toFixed(2);
        
        setTravelData(prev => ({
            ...prev,
            budget: {
                ...prev.budget,
                aaRates: {
                    quantity: totalKm.toString(),
                    unitCost: rate.toFixed(2),
                    totalCost: travelCost,
                }
            }
        }));
        setAaRatesLocked(true);
    };

    // State to track if AA rates are locked (applied from calculator)
    const [aaRatesLocked, setAaRatesLocked] = useState(false);

    // Cost allocation is now auto-calculated, no need for state

    // Emergency request state (for travel within 7 days)
    const [isEmergencyRequest, setIsEmergencyRequest] = useState(false);
    const [emergencyReason, setEmergencyReason] = useState('');

    // Tollgate route type selection (premium or standard)
    const [tollgateRouteType, setTollgateRouteType] = useState<TollgateRouteType>('premium');

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

    // Travel document state
    const [travelData, setTravelData] = useState({
        dateOfIntendedTravel: '',
        purposeOfTravel: '',
        accompanyingAssociates: '',
        travelMode: '',
        vehicleRegistration: '',
        acceptConditions: false,
        itinerary: [{ date: '', from: '', fromCustom: '', to: '', toCustom: '', km: '', justification: '' }],
        hotelReservation: '',
        budget: {
            fuel: { quantity: '', unitCost: '', totalCost: '' },
            aaRates: { quantity: '', unitCost: '', totalCost: '' },
            airBusTickets: { quantity: '', unitCost: '', totalCost: '' },
            overnightAccommodation: { quantity: '', unitCost: '', totalCost: '' },
            lunchDinner: { quantity: '', unitCost: '', totalCost: '' },
            conferencingCost: { quantity: '', unitCost: '', totalCost: '' },
            tollgates: [{ road: '', quantity: '1', unitCost: '', totalCost: '' }] as TollgateEntry[],
            other: { description: '', quantity: '', unitCost: '', totalCost: '' },
        },
    });

    // Autosave / crash recovery (serializable slices only). Disabled in edit mode.
    useFormAutosave({
        formKey: 'hotel-booking',
        enabled: !isEditMode,
        data: { formData, travelData, costAllocation, selectedApprovers, selectedBusinessUnits, aaCalculator, isEmergencyRequest, emergencyReason, tollgateRouteType },
        onRestore: (saved) => {
            if (saved.formData) setFormData(saved.formData);
            if (saved.travelData) setTravelData(saved.travelData);
            if (saved.costAllocation && typeof saved.costAllocation === 'object') setCostAllocation(saved.costAllocation);
            if (saved.selectedApprovers) setSelectedApprovers(prev => ({ ...prev, ...saved.selectedApprovers }));
            if (Array.isArray(saved.selectedBusinessUnits)) setSelectedBusinessUnits(saved.selectedBusinessUnits);
            if (saved.aaCalculator) setAACalculator(saved.aaCalculator);
            if (typeof saved.isEmergencyRequest === 'boolean') setIsEmergencyRequest(saved.isEmergencyRequest);
            if (typeof saved.emergencyReason === 'string') setEmergencyReason(saved.emergencyReason);
            if (saved.tollgateRouteType) setTollgateRouteType(saved.tollgateRouteType);
            setIsDirty(true);
        },
    });

    const addItineraryRow = () => {
        setTravelData(prev => ({
            ...prev,
            itinerary: [...prev.itinerary, { date: '', from: '', fromCustom: '', to: '', toCustom: '', km: '', justification: '' }]
        }));
    };

    const updateItineraryRow = (index: number, field: string, value: string) => {
        setTravelData(prev => {
            const updatedItinerary = prev.itinerary.map((row, i) => {
                if (i !== index) return row;
                const updatedRow = { ...row, [field]: value };
                // Auto-calculate KM when From or To changes (only if neither is 'OTHER')
                if (field === 'from' || field === 'to') {
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
        // Unlock AA rates if itinerary changes (user needs to recalculate)
        if (field === 'from' || field === 'to' || field === 'km') {
            setAaRatesLocked(false);
        }
    };

    const removeItineraryRow = (index: number) => {
        if (travelData.itinerary.length > 1) {
            setTravelData(prev => ({
                ...prev,
                itinerary: prev.itinerary.filter((_, i) => i !== index)
            }));
        }
    };

    // Calculate total tollgates cost
    const calculateTollgatesTotal = () => {
        return travelData.budget.tollgates.reduce((sum, t) => sum + (parseFloat(t.totalCost) || 0), 0);
    };

    const calculateGrandTotal = () => {
        const budget = travelData.budget;
        const tollgatesTotal = calculateTollgatesTotal();
        const values = [
            budget.aaRates.totalCost,
            budget.airBusTickets.totalCost,
            budget.conferencingCost.totalCost,
            budget.other.totalCost,
        ];
        return values.reduce((sum, val) => sum + (parseFloat(val) || 0), tollgatesTotal).toFixed(2);
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

    // ── Travel cost allocation (requestor-filled) ──
    // Tick one unit → it carries the whole grand total. Tick 2+ → split mode:
    // each unit's share is entered and must add up to the full grand total.
    // Mirrors requests/new/travel-auth exactly.
    const allocationGrandTotal = parseFloat(calculateGrandTotal()) || 0;
    const allocationCodes = Object.keys(costAllocation);
    const isSplitAllocation = allocationCodes.length > 1;
    const allocationEnteredTotal = allocationCodes.reduce(
        (sum, code) => sum + (parseFloat(costAllocation[code]) || 0), 0
    );
    const allocationRemaining = allocationGrandTotal - allocationEnteredTotal;
    const allocationFullyAllocated = !isSplitAllocation || Math.abs(allocationRemaining) < 0.01;

    // Finalised allocation to persist / preview: one unit → full total; a split →
    // the entered figures, rounded to cents.
    const finalizeCostAllocation = (): Record<string, string> => {
        const codes = Object.keys(costAllocation);
        if (codes.length === 0) return {};
        if (codes.length === 1) return { [codes[0]]: allocationGrandTotal.toFixed(2) };
        const out: Record<string, string> = {};
        for (const code of codes) out[code] = (parseFloat(costAllocation[code]) || 0).toFixed(2);
        return out;
    };

    const updateBudgetItem = (item: 'fuel' | 'aaRates' | 'airBusTickets' | 'overnightAccommodation' | 'lunchDinner' | 'conferencingCost' | 'other', field: string, value: string) => {
        setTravelData(prev => {
            const currentItem = prev.budget[item];
            const updatedItem = { ...currentItem, [field]: value };
            
            // Auto-calculate total cost when quantity or unit cost changes
            if (field === 'quantity' || field === 'unitCost') {
                const quantity = parseFloat(field === 'quantity' ? value : updatedItem.quantity) || 0;
                const unitCost = parseFloat(field === 'unitCost' ? value : updatedItem.unitCost) || 0;
                updatedItem.totalCost = (quantity * unitCost).toFixed(2);
            }
            
            return {
                ...prev,
                budget: {
                    ...prev.budget,
                    [item]: updatedItem,
                },
            };
        });
    };

    // Tollgate management functions
    const addTollgateRow = () => {
        setTravelData(prev => ({
            ...prev,
            budget: {
                ...prev.budget,
                tollgates: [...prev.budget.tollgates, { road: '', quantity: '1', unitCost: '', totalCost: '' }]
            }
        }));
    };

    const updateTollgateRow = (index: number, field: keyof TollgateEntry, value: string) => {
        setTravelData(prev => {
            const updatedTollgates = prev.budget.tollgates.map((t, i) => {
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
        if (travelData.budget.tollgates.length > 1) {
            setTravelData(prev => ({
                ...prev,
                budget: {
                    ...prev.budget,
                    tollgates: prev.budget.tollgates.filter((_, i) => i !== index)
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
        if (status === 'unauthenticated') {
            router.push('/');
        }
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

                // Store original data for comparison
                setOriginalFormData({
                    guestNames: metadata.guestNames || '',
                    isExternalGuest: false,
                    allocationType: metadata.allocationType || 'marketing_domestic',
                    percentageDiscount: metadata.percentageDiscount || '',
                    reason: metadata.reason || request.description || '',
                    processTravelDocument: metadata.processTravelDocument || false,
                });

                // Pre-fill form with existing data
                setFormData({
                    guestNames: metadata.guestNames || '',
                    isExternalGuest: false,
                    allocationType: metadata.allocationType || 'marketing_domestic',
                    percentageDiscount: metadata.percentageDiscount || '',
                    reason: metadata.reason || request.description || '',
                    processTravelDocument: metadata.processTravelDocument || false,
                });

                // Restore associates: prefer the structured list, else split the
                // legacy joined guestNames string into free-text guests.
                if (Array.isArray(metadata.associates) && metadata.associates.length > 0) {
                    setAssociates(metadata.associates);
                } else if (metadata.guestNames) {
                    setAssociates(
                        String(metadata.guestNames)
                            .split(/[,\n]/)
                            .map((s: string) => s.trim())
                            .filter(Boolean)
                            .map((name: string) => ({ name }))
                    );
                }

                // Load any existing supporting documents so they appear in the
                // travel section (and aren't re-uploaded).
                try {
                    const docRes = await fetch(`/api/requests/${editRequestId}/documents`);
                    if (docRes.ok) {
                        const docData = await docRes.json();
                        const docs = (docData.documents || []).map((d: any) =>
                            makeSupportingDoc({
                                label: d.label || '',
                                description: d.description || '',
                                existing: { id: d.id, filename: d.filename, download_url: d.download_url },
                            })
                        );
                        if (docs.length > 0) setTravelSupportingDocs(docs);
                    }
                } catch {
                    // Non-fatal — start with an empty documents list.
                }

                // Set business units
                if (metadata.selectedBusinessUnits && Array.isArray(metadata.selectedBusinessUnits)) {
                    setSelectedBusinessUnits(metadata.selectedBusinessUnits);
                    setOriginalBusinessUnits(metadata.selectedBusinessUnits);
                }

                // Set travel data if present
                if (metadata.travelDocument) {
                    setTravelData(metadata.travelDocument);
                    setOriginalTravelData(metadata.travelDocument);
                }

                // Restore the requestor's travel cost allocation across edits —
                // normalise legacy/lowercase unit keys to the canonical codes and
                // drop zero/empty entries (mirrors travel-auth).
                if (metadata.travelCostAllocation && typeof metadata.travelCostAllocation === 'object') {
                    const canon = new Map<string, string>(ALLOCATION_UNITS.map(u => [u.code.toLowerCase(), u.code]));
                    canon.set('azam', 'AZRL');
                    const cleaned: Record<string, string> = {};
                    for (const [k, v] of Object.entries(metadata.travelCostAllocation as Record<string, any>)) {
                        const code = canon.get(String(k).toLowerCase());
                        const num = parseFloat(String(v ?? ''));
                        if (code && Number.isFinite(num) && num > 0) cleaned[code] = String(v);
                    }
                    setCostAllocation(cleaned);
                }

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

    // Fetch business units
    useEffect(() => {
        const fetchBusinessUnits = async () => {
            try {
                const response = await fetch('/api/business-units');
                if (response.ok) {
                    const data = await response.json();
                    setBusinessUnits(data.businessUnits || []);
                }
            } catch (err) {
                console.error('Failed to fetch business units:', err);
            } finally {
                setBusinessUnitsLoading(false);
            }
        };

        if (status === 'authenticated') {
            fetchBusinessUnits();
        }
    }, [status]);

    // Fetch users for approver selection
    useEffect(() => {
        const fetchUsers = async () => {
            try {
                const response = await fetch('/api/users');
                if (response.ok) {
                    const data = await response.json();
                    setUsers(data.users || []);
                }
            } catch (err) {
                console.error('Failed to fetch users:', err);
            } finally {
                setLoadingUsers(false);
            }
        };

        if (status === 'authenticated') {
            fetchUsers();
        }
    }, [status]);

    // Auto-resolve approvers from HRIMS organogram (only on new requests, not edits)
    useEffect(() => {
        const resolveApprovers = async () => {
            if (!session?.user?.email || isEditMode) { setLoadingApproverResolution(false); return; }
            setLoadingApproverResolution(true);
            try {
                const response = await fetch(`/api/hrims/resolve-approvers?email=${encodeURIComponent(session.user.email)}&formType=hotel-booking`);
                const data = await response.json();
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

    // Filter users by search for a specific role
    const getFilteredUsersForRole = (roleKey: string) => {
        const searchTerm = approverSearch[roleKey] || '';
        const alreadySelectedIds = Object.values(selectedApprovers).filter(id => id);
        // The requester can never approve their own request — hide themselves from the picker.
        const currentUserId = (session?.user as any)?.id;
        return users.filter(u => u.id !== currentUserId).filter(u => {
            const matchesSearch = searchTerm
                ? (u.display_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                   u.email?.toLowerCase().includes(searchTerm.toLowerCase()))
                : true;
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

    // Add a new booking instance for a business unit (allows same hotel multiple times)
    const handleAddBusinessUnit = (unitId: string, unitName: string) => {
        const instanceId = `${unitId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        // Look up the HRIMS code for this unit so it's carried along with the
        // booking — needed later for the travel-doc itinerary autofill.
        const unit = businessUnits.find(u => u.id === unitId);
        setSelectedBusinessUnits(prev => [...prev, {
            instanceId,
            id: unitId,
            name: unitName,
            code: unit?.code,
            bookingMade: false,
            arrivalDate: '',
            departureDate: '',
            numberOfNights: '',
            numberOfRooms: '',
            accommodationType: 'accommodation_only',
            specialArrangements: 'N/A',
        }]);
    };

    // Remove a specific booking instance
    const handleRemoveBusinessUnit = (instanceId: string) => {
        setSelectedBusinessUnits(prev => prev.filter(u => u.instanceId !== instanceId));
    };

    const handleBusinessUnitFieldChange = (instanceId: string, field: keyof SelectedBusinessUnit, value: string | boolean) => {
        setSelectedBusinessUnits(prev =>
            prev.map(u => {
                if (u.instanceId !== instanceId) return u;
                const updated = { ...u, [field]: value };
                // Auto-calculate nights when dates change
                if ((field === 'arrivalDate' || field === 'departureDate') && updated.arrivalDate && updated.departureDate) {
                    const start = new Date(updated.arrivalDate);
                    const end = new Date(updated.departureDate);
                    const diffTime = Math.abs(end.getTime() - start.getTime());
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    updated.numberOfNights = diffDays.toString();
                }
                return updated;
            })
        );
    };

    const unsavedPrompt = useUnsavedChangesPrompt({
        isDirty,
        disabled: loading || savingDraft,
    });

    // Helper to get approver display name
    const getApproverName = (approverId: string) => {
        const user = users.find(u => u.id === approverId);
        return user ? user.display_name : approverId || 'None';
    };

    // Helper to collect field changes for approver edit tracking
    const collectFieldChanges = () => {
        if (!originalFormData) return [];
        const changes: { fieldName: string; oldValue: any; newValue: any }[] = [];

        if (formData.guestNames !== originalFormData.guestNames) {
            changes.push({ fieldName: 'guestNames', oldValue: originalFormData.guestNames, newValue: formData.guestNames });
        }
        if (formData.isExternalGuest !== originalFormData.isExternalGuest) {
            changes.push({ fieldName: 'isExternalGuest', oldValue: originalFormData.isExternalGuest, newValue: formData.isExternalGuest });
        }
        if (formData.allocationType !== originalFormData.allocationType) {
            changes.push({ fieldName: 'allocationType', oldValue: originalFormData.allocationType, newValue: formData.allocationType });
        }
        if (formData.percentageDiscount !== originalFormData.percentageDiscount) {
            changes.push({ fieldName: 'percentageDiscount', oldValue: originalFormData.percentageDiscount, newValue: formData.percentageDiscount });
        }
        if (formData.reason !== originalFormData.reason) {
            changes.push({ fieldName: 'reason', oldValue: originalFormData.reason, newValue: formData.reason });
        }
        if (JSON.stringify(selectedBusinessUnits) !== JSON.stringify(originalBusinessUnits)) {
            changes.push({ fieldName: 'selectedBusinessUnits', oldValue: JSON.stringify(originalBusinessUnits), newValue: JSON.stringify(selectedBusinessUnits) });
        }
        if (formData.processTravelDocument && originalTravelData && JSON.stringify(travelData) !== JSON.stringify(originalTravelData)) {
            changes.push({ fieldName: 'travelDocument', oldValue: JSON.stringify(originalTravelData), newValue: JSON.stringify(travelData) });
        }

        // Track approval workflow changes
        if (originalApprovers) {
            const roleLabels: Record<string, string> = {
                hod: 'HOD Approver',
                hr_director: 'Chief Human Capital Officer Approver',
                finance_director: 'Chief Finance Officer Approver',
                ceo: 'CEO Approver',
            };
            for (const role of Object.keys(roleLabels)) {
                const oldApprover = originalApprovers[role] || '';
                const newApprover = selectedApprovers[role] || '';
                if (oldApprover !== newApprover) {
                    changes.push({
                        fieldName: roleLabels[role],
                        oldValue: getApproverName(oldApprover),
                        newValue: getApproverName(newApprover),
                    });
                }
            }
        }

        return changes;
    };

    // Handle approver save (edit mode with change tracking)
    const handleApproverSave = async () => {
        setLoading(true);
        setError(null);

        try {
            const fieldChanges = collectFieldChanges();
            const approversArray = [selectedApprovers.line_manager, selectedApprovers.functional_head, selectedApprovers.hrd, selectedApprovers.ceo].filter(Boolean);

            const response = await fetch(`/api/requests/${editRequestId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: formData.processTravelDocument
                        ? `Complimentary Booking & Travel Authorisation: ${formData.guestNames}`
                        : `Hotel Booking: ${formData.guestNames}`,
                    description: formData.reason,
                    metadata: {
                        type: 'hotel_booking',
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        guestNames: formData.guestNames,
                        associates: associates,
                        watchers: associateWatcherIds,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && {
                            travelDocument: travelData,
                            grandTotal: calculateGrandTotal(),
                            travelCostAllocation: finalizeCostAllocation(),
                        }),
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                    },
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save changes');
            }

            // Record modifications if there are changes
            if (fieldChanges.length > 0) {
                await fetch(`/api/requests/${editRequestId}/approver-edit`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fieldChanges }),
                });
            }

            if (formData.processTravelDocument) {
                await uploadSupportingDocuments(String(editRequestId), travelSupportingDocs);
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
                    title: formData.processTravelDocument
                        ? `Complimentary Booking & Travel Authorisation: ${formData.guestNames || 'Draft'}`
                        : `Hotel Booking: ${formData.guestNames || 'Draft'}`,
                    description: formData.reason || 'Draft request',
                    metadata: {
                        type: 'hotel_booking',
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        guestNames: formData.guestNames,
                        associates: associates,
                        watchers: associateWatcherIds,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && {
                            travelDocument: travelData,
                            grandTotal: calculateGrandTotal(),
                            travelCostAllocation: finalizeCostAllocation(),
                        }),
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

            if (formData.processTravelDocument) {
                await uploadSupportingDocuments(String(editRequestId), travelSupportingDocs);
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

    // Shared inline styles so the preview and the printed HTML look the same.
    const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11 };
    const cellStyle: React.CSSProperties = { border: '1px solid #333', padding: '6px 8px', verticalAlign: 'top' };
    const headCellStyle: React.CSSProperties = { ...cellStyle, background: '#F3EADC', color: '#5E4426', fontWeight: 700, textAlign: 'left' };
    const labelCellStyle: React.CSSProperties = { ...cellStyle, background: '#FAF7F0', fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em', width: '22%' };

    const ACCOMMODATION_LABELS_HB: Record<string, string> = {
        accommodation_only: 'Accommodation Only (Bed only)',
        accommodation_and_breakfast: 'Accommodation + Breakfast',
        accommodation_and_meals: 'Accommodation + Meals',
        accommodation_meals_drink: 'Accommodation + Meals + 1 Soft Drink/Meal',
    };
    const ALLOCATION_LABELS_HB: Record<string, string> = {
        marketing_domestic: 'Marketing – Domestic',
        marketing_international: 'Marketing – International',
        administration: 'Administration',
        promotions: 'Promotions',
        personnel: 'Personnel',
    };

    const hotelBookingDocumentHeader: DocumentHeader = {
        logoUrl: '/images/RTG_LOGO.png',
        docNo: 'DOC NO. FIN 101',
        department: 'DEPARTMENT: FINANCE',
        page: 'PAGE: 1 of 1',
    };

    const buildPreviewSections = (): PreviewSection[] => {
        const requestTimestamp = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const requestorName = requestor.name || '—';

        const baseSections: PreviewSection[] = [
            // Main form header section — table layout
            {
                content: (
                    <table className="doc-grid" style={tableStyle}>
                        <tbody>
                            <tr>
                                <td style={labelCellStyle}>Name of Employee</td>
                                <td style={cellStyle}>{requestorName}</td>
                                <td style={labelCellStyle}>Department</td>
                                <td style={cellStyle}>{requestor.department || '—'}</td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Date &amp; Time of Request</td>
                                <td style={cellStyle}>{requestTimestamp}</td>
                                <td style={labelCellStyle}>Business Unit</td>
                                <td style={cellStyle}>{requestor.businessUnit || '—'}</td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Guest Details</td>
                                <td style={cellStyle} colSpan={3}>{formData.guestNames || '—'}</td>
                            </tr>
                        </tbody>
                    </table>
                ),
            },
            // Business units and booking details grid table
            {
                title: 'Business Units and Booking Details',
                content: (
                    <table className="doc-grid" style={tableStyle}>
                        <thead>
                            <tr>
                                <th style={headCellStyle}>Business Unit</th>
                                <th style={headCellStyle}>Arrival Date</th>
                                <th style={headCellStyle}>Departure Date</th>
                                <th style={{ ...headCellStyle, textAlign: 'right', width: '8%' }}>Nights</th>
                                <th style={{ ...headCellStyle, textAlign: 'right', width: '8%' }}>Rooms</th>
                                <th style={headCellStyle}>Accommodation Type</th>
                                <th style={headCellStyle}>Special Arrangements</th>
                            </tr>
                        </thead>
                        <tbody>
                            {selectedBusinessUnits.length === 0 ? (
                                <tr>
                                    <td style={cellStyle} colSpan={7}>No business units selected.</td>
                                </tr>
                            ) : (
                                selectedBusinessUnits.map((u, i) => (
                                    <tr key={u.instanceId || i}>
                                        <td style={cellStyle}>{u.name}</td>
                                        <td style={cellStyle}>{u.arrivalDate || '—'}</td>
                                        <td style={cellStyle}>{u.departureDate || '—'}</td>
                                        <td style={{ ...cellStyle, textAlign: 'right' }}>{u.numberOfNights || '—'}</td>
                                        <td style={{ ...cellStyle, textAlign: 'right' }}>{u.numberOfRooms || '—'}</td>
                                        <td style={cellStyle}>{ACCOMMODATION_LABELS_HB[u.accommodationType] || u.accommodationType || '—'}</td>
                                        <td style={cellStyle}>{u.specialArrangements || '—'}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                ),
            },
            // Cost allocation, percentage discount, reason for complimentary
            {
                title: 'Cost Allocation, Discount & Reason',
                content: (
                    <table className="doc-grid" style={tableStyle}>
                        <tbody>
                            <tr>
                                <td style={labelCellStyle}>Cost Allocation</td>
                                <td style={cellStyle}>{ALLOCATION_LABELS_HB[formData.allocationType] || formData.allocationType || '—'}</td>
                                <td style={labelCellStyle}>Percentage Discount</td>
                                <td style={{ ...cellStyle, width: '18%' }}>
                                    {formData.percentageDiscount ? `${formData.percentageDiscount}%` : '—'}
                                </td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Reason for Complimentary</td>
                                <td style={cellStyle} colSpan={3}>{formData.reason || '—'}</td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Process Travel Document</td>
                                <td style={cellStyle} colSpan={3}>{formData.processTravelDocument ? 'Yes' : 'No'}</td>
                            </tr>
                        </tbody>
                    </table>
                ),
            },
        ];

        // Travel authorisation is a distinct document. When bundled with the
        // comp booking it renders as a SECOND page using the shared travel-auth
        // builder, so the travel page is identical to a standalone travel
        // authorisation — its own HR APX-27 header, cost allocation and approval
        // block. One workflow, two documents.
        const currentUserId = (session?.user as any)?.id;
        const isOnBehalf = !!onBehalfOf;
        const approverDisplay: Record<string, { name?: string }> = {};
        for (const r of approvalRoles) {
            const u = users.find(u => u.id === selectedApprovers[r.key]);
            approverDisplay[r.key] = { name: u?.display_name };
        }
        const travelPageSections: PreviewSection[] = formData.processTravelDocument ? [
            buildDocumentHeaderSection(
                buildTravelAuthDocumentHeader(false),
                'Local Travel Authorisation',
                { pageBreakBefore: true }
            ),
            ...buildTravelAuthPreviewSections({
                employee: {
                    name: requestorName,
                    department: requestor.department,
                    businessUnit: requestor.businessUnit,
                },
                requestTimestamp,
                dateOfIntendedTravel: travelData.dateOfIntendedTravel,
                purposeOfTravel: travelData.purposeOfTravel,
                accompanyingAssociates: travelData.accompanyingAssociates,
                travelMode: travelData.travelMode,
                vehicleRegistration: travelData.vehicleRegistration,
                isInternational: false,
                isEmergencyRequest,
                emergencyReason,
                acceptConditions: travelData.acceptConditions,
                travellerName: requestorName,
                travellerSignatureUrl: isOnBehalf
                    ? null
                    : (currentUserId ? `/api/signature/view?userId=${encodeURIComponent(currentUserId)}` : null),
                onBehalf: isOnBehalf,
                itinerary: travelData.itinerary,
                budget: travelData.budget,
                grandTotal: calculateGrandTotal(),
                costAllocation: finalizeCostAllocation(),
                approvers: approverDisplay,
            }),
        ] : [];

        const approvalSection: PreviewSection = {
            title: 'Approval',
            content: (
                <table className="doc-grid approval-row" style={tableStyle}>
                    <thead>
                        <tr>
                            {approvalRoles.map(r => (
                                <th key={r.key} style={{ ...headCellStyle, textAlign: 'center', width: '25%' }}>
                                    {r.label}
                                    <div style={{ fontSize: 9, fontWeight: 500, color: '#7C5A33', textTransform: 'none' }}>
                                        {r.description}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            {approvalRoles.map(r => {
                                const u = users.find(u => u.id === selectedApprovers[r.key]);
                                return (
                                    <td key={r.key} style={{ ...cellStyle, width: '25%' }}>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#555', textTransform: 'uppercase' }}>Name</div>
                                        <div style={{ fontSize: 11, marginBottom: 8 }}>{u?.display_name || '—'}</div>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#555', textTransform: 'uppercase' }}>Signature</div>
                                        <div
                                            className="sig-line"
                                            style={{ borderBottom: '1px solid #666', height: 28, marginTop: 4, marginBottom: 8 }}
                                        />
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#555', textTransform: 'uppercase' }}>Date</div>
                                        <div
                                            className="sig-line"
                                            style={{ borderBottom: '1px solid #666', height: 18, marginTop: 4 }}
                                        />
                                    </td>
                                );
                            })}
                        </tr>
                    </tbody>
                </table>
            ),
        };

        // Page 1 = complimentary booking (FIN 101) with its own approval block.
        // Page 2 (when a travel document is bundled) = the travel authorisation
        // document, which carries its own approval block inside the builder.
        return [...baseSections, approvalSection, ...travelPageSections];
    };

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

        // Open confirmation modal with preview before real submit
        setShowConfirm(true);
    };

    const performSubmit = async () => {
        setLoading(true);
        setError(null);

        // Validation
        const errors: string[] = [];

        // Required: At least one business unit
        if (selectedBusinessUnits.length === 0) {
            errors.push('Please select at least one business unit');
        }

        // Required: Business unit fields
        for (const unit of selectedBusinessUnits) {
            if (!unit.arrivalDate) {
                errors.push(`Arrival date is required for ${unit.name}`);
            }
            if (!unit.departureDate) {
                errors.push(`Departure date is required for ${unit.name}`);
            }
            if (!unit.numberOfNights) {
                errors.push(`Number of nights is required for ${unit.name}`);
            }
            if (!unit.numberOfRooms) {
                errors.push(`Number of rooms is required for ${unit.name}`);
            }
            if (!unit.accommodationType) {
                errors.push(`Accommodation type is required for ${unit.name}`);
            }
        }

        // Required: Reason for complimentary
        if (!formData.reason.trim()) {
            errors.push('Reason for complimentary is required');
        }

        // Approvers are optional per step — not every role must be filled — but
        // at least one is required so there's an approval chain to route through.
        const anyApproverSelected = [
            selectedApprovers.line_manager,
            selectedApprovers.functional_head,
            selectedApprovers.hrd,
            selectedApprovers.ceo,
        ].some(Boolean);
        if (!anyApproverSelected) {
            errors.push('Please select at least one approver');
        }

        // Validate dates are not in the past
        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);
        
        for (const unit of selectedBusinessUnits) {
            if (unit.arrivalDate) {
                const arrivalDate = new Date(unit.arrivalDate);
                if (arrivalDate < todayDate) {
                    errors.push(`Arrival date for ${unit.name} cannot be in the past`);
                }
            }
            if (unit.departureDate) {
                const departureDate = new Date(unit.departureDate);
                if (departureDate < todayDate) {
                    errors.push(`Departure date for ${unit.name} cannot be in the past`);
                }
            }
        }

        // If processTravelDocument is checked, validate travel fields
        if (formData.processTravelDocument) {
            if (!travelData.dateOfIntendedTravel) {
                errors.push('Date of intended travel is required');
            } else {
                const travelDate = new Date(travelData.dateOfIntendedTravel);
                if (travelDate < todayDate) {
                    errors.push('Date of intended travel cannot be in the past');
                }
            }
            // 7-day advance validation
            if (travelData.dateOfIntendedTravel && isTravelWithin7Days()) {
                if (!isEmergencyRequest) {
                    errors.push('Travel within 7 days requires flagging as an emergency request');
                } else if (!emergencyReason.trim()) {
                    errors.push('Emergency reason is required for travel within 7 days');
                }
            }
            if (!travelData.purposeOfTravel.trim()) {
                errors.push('Purpose of travel is required');
            }
            if (!travelData.travelMode.trim()) {
                errors.push('Travel mode is required');
            }
            if (travelData.travelMode === 'personal_motor_vehicle' && !travelData.vehicleRegistration?.trim()) {
                errors.push('Vehicle registration number is required for personal motor vehicle');
            }
            if (!travelData.acceptConditions) {
                errors.push('You must accept the travel conditions');
            }
            // At least one itinerary row with data
            const hasValidItinerary = travelData.itinerary.some(
                row => row.date || row.from || row.to
            );
            if (!hasValidItinerary) {
                errors.push('At least one travel itinerary row is required');
            }
            // At least one budget row with data
            const budget = travelData.budget;
            const tollgatesTotal = budget.tollgates.reduce((sum, t) => sum + (parseFloat(t.totalCost) || 0), 0);
            const hasValidBudget = 
                (budget.aaRates.totalCost && parseFloat(budget.aaRates.totalCost) > 0) ||
                (budget.airBusTickets.totalCost && parseFloat(budget.airBusTickets.totalCost) > 0) ||
                (budget.conferencingCost.totalCost && parseFloat(budget.conferencingCost.totalCost) > 0) ||
                (tollgatesTotal > 0) ||
                (budget.other.totalCost && parseFloat(budget.other.totalCost) > 0);
            if (!hasValidBudget) {
                errors.push('At least one travel budget item is required');
            }
            // Cost-allocation split must account for every cent of the grand total.
            if (isSplitAllocation && !allocationFullyAllocated) {
                errors.push(
                    `Travel cost allocation must total USD ${allocationGrandTotal.toFixed(2)} — every cent must be allocated ` +
                    `(currently USD ${allocationEnteredTotal.toFixed(2)}).`
                );
            }
        }

        if (errors.length > 0) {
            setError(errors.join('. '));
            setLoading(false);
            return;
        }

        try {
            // Convert approvers object to ordered array for sequential approval
            // Order: HOD -> HR Director -> Finance Director -> CEO
            const approversArray = [
                selectedApprovers.line_manager,
                selectedApprovers.functional_head,
                selectedApprovers.hrd,
                selectedApprovers.ceo,
            ].filter(Boolean); // Remove any empty values

            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: formData.processTravelDocument
                        ? `Complimentary Booking & Travel Authorisation: ${formData.guestNames}`
                        : `Hotel Booking: ${formData.guestNames}`,
                    description: formData.reason,
                    priority: 'normal',
                    category: 'hotel',
                    requestType: 'hotel_booking',
                    status: 'pending', // Submit for approval immediately
                    metadata: {
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        guestNames: formData.guestNames,
                        associates: associates,
                        watchers: associateWatcherIds,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && {
                            travelDocument: travelData,
                            grandTotal: calculateGrandTotal(),
                            travelCostAllocation: finalizeCostAllocation(),
                            isEmergencyRequest: isTravelWithin7Days() ? isEmergencyRequest : false,
                            emergencyReason: isTravelWithin7Days() && isEmergencyRequest ? emergencyReason : '',
                        }),
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                    },
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to create hotel booking request');
            }

            if (formData.processTravelDocument) {
                await uploadSupportingDocuments(data.request.id, travelSupportingDocs);
            }

            router.push(`/requests/comp/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to create hotel booking request');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveDraft = async () => {
        setSavingDraft(true);
        setError(null);

        try {
            // Convert approvers object to ordered array for sequential approval
            const approversArray = [
                selectedApprovers.line_manager,
                selectedApprovers.functional_head,
                selectedApprovers.hrd,
                selectedApprovers.ceo,
            ].filter(Boolean);

            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: formData.processTravelDocument
                        ? `Complimentary Booking & Travel Authorisation: ${formData.guestNames || 'Draft'}`
                        : `Hotel Booking: ${formData.guestNames || 'Draft'}`,
                    description: formData.reason || 'Draft request',
                    priority: 'normal',
                    category: 'hotel',
                    requestType: 'hotel_booking',
                    status: 'draft',
                    metadata: {
                        referenceCode: existingReferenceCode || referenceCode || undefined,
                        guestNames: formData.guestNames,
                        associates: associates,
                        watchers: associateWatcherIds,
                        isExternalGuest: formData.isExternalGuest,
                        selectedBusinessUnits: selectedBusinessUnits,
                        allocationType: formData.allocationType,
                        percentageDiscount: formData.percentageDiscount,
                        reason: formData.reason,
                        processTravelDocument: formData.processTravelDocument,
                        ...(formData.processTravelDocument && {
                            travelDocument: travelData,
                            grandTotal: calculateGrandTotal(),
                            travelCostAllocation: finalizeCostAllocation(),
                            isEmergencyRequest: isTravelWithin7Days() ? isEmergencyRequest : false,
                            emergencyReason: isTravelWithin7Days() && isEmergencyRequest ? emergencyReason : '',
                        }),
                        approvers: approversArray,
                        approverRoles: selectedApprovers,
                        useParallelApprovals: false,
                        onBehalfOf: onBehalfOf || null,
                    },
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to save draft');
            }

            if (formData.processTravelDocument) {
                await uploadSupportingDocuments(data.request.id, travelSupportingDocs);
            }

            router.push(`/requests/comp/${data.request.id}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save draft');
        } finally {
            setSavingDraft(false);
        }
    };

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Hotel Booking" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    const pageTitle = isApproverEditing ? 'Edit Hotel Booking (Approver)' : isEditMode ? 'Edit Hotel Booking' : 'Hotel Booking';

    return (
        <AppLayout title={pageTitle} showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        {isApproverEditing ? 'Edit Hotel Booking' : 'Complimentary Hotel Staff Booking Form'}
                    </h1>
                    <div className="mt-4 max-w-lg mx-auto">
                        <ReferenceCodeBanner
                            requestType="hotel_booking"
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

                {error && (
                    <Card className="mb-4 bg-danger-50 border-danger-200">
                        <p className="text-danger-600 text-sm">{error}</p>
                    </Card>
                )}

                <div className="space-y-6">
                    {/* Filing on behalf of — shown at the top; only assigned assistants see it */}
                    <Card className="p-6">
                        <OnBehalfOfField value={onBehalfOf} onChange={setOnBehalfOf} />
                    </Card>

                    {/* Requestor Information Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Requestor Information</h3>
                        {requestor.isOnBehalf && (
                            <p className="text-xs text-primary-700 bg-primary-50 border border-primary-200 rounded-lg px-3 py-2 mb-4">
                                Showing details for <strong>{onBehalfOf?.name}</strong>, on whose behalf you are filing this request.
                            </p>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Name</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestor.name || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Business Unit</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestor.businessUnit || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Department</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {requestor.department || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Date</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {today}
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Guest Section */}
                    <Card className="p-6">
                        <div className="space-y-6">
                            <AssociatesField value={associates} onChange={handleAssociatesChange} />
                        </div>
                    </Card>

                    {/* Business Units Selection */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Select Business Units <span className="text-danger-500">*</span></h3>
                        <p className="text-sm text-gray-500 mb-4">Add business units for this booking. You can add the same hotel multiple times if visiting on different dates.</p>
                        
                        {/* Available Hotels - Add Buttons */}
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-gray-600 mb-2">Add a Hotel:</label>
                            <div className="flex flex-wrap gap-2">
                                {businessUnits.map((unit) => {
                                    const instanceCount = selectedBusinessUnits.filter(u => u.id === unit.id).length;
                                    return (
                                        <button
                                            key={unit.id}
                                            type="button"
                                            onClick={() => handleAddBusinessUnit(unit.id, unit.name)}
                                            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:border-primary-400 hover:bg-primary-50 transition-all text-sm font-medium text-gray-700"
                                        >
                                            <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                            </svg>
                                            {unit.name}
                                            {instanceCount > 0 && (
                                                <span className="ml-1 px-1.5 py-0.5 bg-primary-100 text-primary-700 text-xs rounded-full">{instanceCount}</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            {businessUnitsLoading && (
                                <div className="text-center py-4 text-gray-500">
                                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500 mx-auto mb-2" />
                                    <p className="text-sm">Loading hotels...</p>
                                </div>
                            )}
                        </div>

                        {/* Selected Booking Entries */}
                        {selectedBusinessUnits.length > 0 ? (
                            <div className="space-y-4">
                                <label className="block text-sm font-medium text-gray-600">Selected Bookings ({selectedBusinessUnits.length}):</label>
                                {selectedBusinessUnits.map((selectedUnit, index) => (
                                    <div
                                        key={selectedUnit.instanceId}
                                        className="rounded-xl border border-primary-300 bg-primary-50/50 overflow-hidden"
                                    >
                                        <div className="p-4 bg-primary-100/50 flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs flex items-center justify-center font-bold">{index + 1}</span>
                                                <span className="font-semibold text-gray-900">{selectedUnit.name}</span>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-gray-200">
                                                    <span className="text-xs text-gray-600">Booking Made?</span>
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedUnit.bookingMade}
                                                        onChange={() => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'bookingMade', !selectedUnit.bookingMade)}
                                                        className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                                                    />
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveBusinessUnit(selectedUnit.instanceId)}
                                                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                                    title="Remove this booking"
                                                >
                                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>

                                        <div className="bg-white p-4 space-y-4">
                                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                                <Input 
                                                    type="date"
                                                    label="Arrival Date *"
                                                    value={selectedUnit.arrivalDate}
                                                    onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'arrivalDate', e.target.value)}
                                                    required
                                                    min={todayISO}
                                                />
                                                <Input
                                                    type="date"
                                                    label="Departure Date *"
                                                    value={selectedUnit.departureDate}
                                                    onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'departureDate', e.target.value)}
                                                    required
                                                    min={selectedUnit.arrivalDate || todayISO}
                                                />
                                                <Input
                                                    type="number"
                                                    label="No. Of Nights *"
                                                    value={selectedUnit.numberOfNights}
                                                    placeholder="Auto-calculated"
                                                    readOnly
                                                    className="bg-gray-50"
                                                />
                                                <Input
                                                    type="number"
                                                    label="No. Of Rooms *"
                                                    value={selectedUnit.numberOfRooms}
                                                    onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'numberOfRooms', e.target.value)}
                                                    required
                                                    min="1"
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-sm font-semibold text-gray-700 mb-2 uppercase">Accommodation Type <span className="text-danger-500">*</span></label>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                    <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                        <input
                                                            type="radio"
                                                            name={`accommodationType_${selectedUnit.instanceId}`}
                                                            value="accommodation_only"
                                                            checked={selectedUnit.accommodationType === 'accommodation_only'}
                                                            onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'accommodationType', e.target.value)}
                                                            className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                        />
                                                        <span className="text-sm text-gray-700">Accommodation Only (Bed only)</span>
                                                    </label>
                                                    <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                        <input
                                                            type="radio"
                                                            name={`accommodationType_${selectedUnit.instanceId}`}
                                                            value="accommodation_and_breakfast"
                                                            checked={selectedUnit.accommodationType === 'accommodation_and_breakfast'}
                                                            onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'accommodationType', e.target.value)}
                                                            className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                        />
                                                        <span className="text-sm text-gray-700">Bed & Breakfast</span>
                                                    </label>
                                                    <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                        <input
                                                            type="radio"
                                                            name={`accommodationType_${selectedUnit.instanceId}`}
                                                            value="accommodation_and_meals"
                                                            checked={selectedUnit.accommodationType === 'accommodation_and_meals'}
                                                            onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'accommodationType', e.target.value)}
                                                            className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                        />
                                                        <span className="text-sm text-gray-700">Accommodation & Meals</span>
                                                    </label>
                                                    <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200">
                                                        <input
                                                            type="radio"
                                                            name={`accommodationType_${selectedUnit.instanceId}`}
                                                            value="accommodation_meals_drink"
                                                            checked={selectedUnit.accommodationType === 'accommodation_meals_drink'}
                                                            onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'accommodationType', e.target.value)}
                                                            className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                                        />
                                                        <span className="text-sm text-gray-700">Accommodation, Meals & Soft Drink</span>
                                                    </label>
                                                </div>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Special Arrangements</label>
                                                <textarea
                                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]"
                                                    value={selectedUnit.specialArrangements}
                                                    onChange={(e) => handleBusinessUnitFieldChange(selectedUnit.instanceId, 'specialArrangements', e.target.value)}
                                                    placeholder="Any special arrangements for this booking..."
                                                />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-8 text-gray-500 border-2 border-dashed border-gray-200 rounded-xl">
                                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                                </svg>
                                <p className="font-medium">No hotels selected yet</p>
                                <p className="text-sm mt-1">Click on a hotel above to add it to your booking</p>
                            </div>
                        )}
                    </Card>

                    {/* Allocation is now decided by the HR Director at approval time
                        — both the category (Marketing, Admin, etc.) and the
                        business-unit cost split. The selector that used to live
                        here was removed so the requester doesn't pre-commit a
                        choice the HRD has to override anyway. */}
                    <Card className="p-6 bg-amber-50 border-amber-200">
                        <div className="flex items-start gap-3">
                            <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <div>
                                <p className="text-sm font-semibold text-amber-900">Cost allocation handled at approval</p>
                                <p className="text-xs text-amber-800 mt-1">
                                    The Chief Human Capital Officer will allocate this complimentary booking across the
                                    appropriate business units and category (Marketing, Administration, etc.)
                                    when they review the request. You don&apos;t need to pick an allocation here.
                                </p>
                            </div>
                        </div>
                    </Card>

                    {/* Details */}
                    <Card className="p-6 space-y-6">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Reason for complimentary <span className="text-danger-500">*</span></label>
                            <textarea
                                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[80px]"
                                value={formData.reason}
                                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                            />
                        </div>
                    </Card>

                    {/* Travel Document Processing */}
                    <Card className="p-6">
                        <div className="flex items-start gap-4">
                            <input
                                type="checkbox"
                                id="processTravelDocument"
                                checked={formData.processTravelDocument}
                                onChange={(e) => {
                                    const enable = e.target.checked;
                                    setFormData({ ...formData, processTravelDocument: enable });
                                    // Auto-fill the inline travel doc from the complimentary
                                    // booking data the moment the user enables it. We only
                                    // seed empty fields so a user who toggled off-and-on
                                    // doesn't lose any in-progress edits, and we generate
                                    // one itinerary leg per booked business unit using its
                                    // arrival / departure dates.
                                    if (enable) {
                                        const sortedStays = [...selectedBusinessUnits]
                                            .filter(bu => bu.arrivalDate || bu.departureDate)
                                            .sort((a, b) => {
                                                const ad = a.arrivalDate ? new Date(a.arrivalDate).getTime() : 0;
                                                const bd = b.arrivalDate ? new Date(b.arrivalDate).getTime() : 0;
                                                return ad - bd;
                                            });
                                        const firstArrival = sortedStays[0]?.arrivalDate || '';
                                        // Resolve a TRAVEL_LOCATIONS code for a booked business
                                        // unit. The unit carries the HRIMS code directly (e.g.
                                        // "MRC"), so that's the primary match. Fall back to a
                                        // tolerant name match for any HRIMS units whose codes
                                        // don't line up with the travel-auth list. Returns ''
                                        // when no dropdown entry can represent this unit.
                                        const normalise = (s: string) =>
                                            s.toLowerCase()
                                                .replace(/\s*\([^)]*\)\s*/g, ' ')
                                                .replace(/[^a-z0-9]+/g, ' ')
                                                .trim();
                                        const codeForUnit = (bu: { code?: string; name?: string }): string => {
                                            const rawCode = (bu.code || '').trim().toUpperCase();
                                            if (rawCode) {
                                                const byCode = TRAVEL_LOCATIONS.find(l => l.code === rawCode);
                                                if (byCode) return byCode.code;
                                            }
                                            const name = bu.name || '';
                                            if (!name) return '';
                                            const upper = name.trim().toUpperCase();
                                            const codeHit = TRAVEL_LOCATIONS.find(l => l.code === upper);
                                            if (codeHit) return codeHit.code;
                                            const n = normalise(name);
                                            const hit = TRAVEL_LOCATIONS.find(l => {
                                                if (l.code === 'OTHER') return false;
                                                const locName = normalise(l.name);
                                                return locName === n || locName.includes(n) || n.includes(locName);
                                            });
                                            return hit?.code || '';
                                        };
                                        const seededItinerary = sortedStays.length > 0
                                            ? sortedStays.map((bu, i) => {
                                                const prev = sortedStays[i - 1];
                                                // Match HRIMS units directly to TRAVEL_LOCATIONS
                                                // codes. If a unit doesn't resolve to a known
                                                // dropdown entry we leave the field blank rather
                                                // than picking "Other" — the user wants the
                                                // dropdown populated, not coerced.
                                                const fromCode = prev ? codeForUnit(prev) : '';
                                                const toCode = codeForUnit(bu);
                                                return {
                                                    date: bu.arrivalDate || '',
                                                    from: fromCode,
                                                    fromCustom: '',
                                                    to: toCode,
                                                    toCustom: '',
                                                    km: '',
                                                    justification: `Travel to ${bu.name}${bu.departureDate ? ` (departs ${bu.departureDate})` : ''}`,
                                                };
                                            })
                                            : null;

                                        setTravelData(prev => {
                                            // If the user already has itinerary content, leave
                                            // it; only seed when the travel doc is genuinely
                                            // blank. Otherwise we'd clobber their edits.
                                            const itineraryIsBlank =
                                                prev.itinerary.length === 0 ||
                                                prev.itinerary.every(r => !r.date && !r.from && !r.to && !r.km && !r.justification);

                                            return {
                                                ...prev,
                                                dateOfIntendedTravel: prev.dateOfIntendedTravel || firstArrival,
                                                purposeOfTravel: prev.purposeOfTravel || formData.reason || '',
                                                accompanyingAssociates: prev.accompanyingAssociates || formData.guestNames || '',
                                                itinerary: seededItinerary && itineraryIsBlank ? seededItinerary : prev.itinerary,
                                            };
                                        });
                                    }
                                }}
                                className="mt-1 w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded cursor-pointer"
                            />
                            <label htmlFor="processTravelDocument" className="cursor-pointer">
                                <span className="font-semibold text-gray-900 block">Process Travel Document</span>
                                <span className="text-sm text-gray-500 mt-1 block">
                                    Check this box if you would like to process your travel authorization document along with this booking request.
                                    Date of travel, purpose, accompanying associates and itinerary will be pre-filled from your booking.
                                </span>
                            </label>
                        </div>
                    </Card>

                    {/* Travel Authorization Form - Conditionally Rendered */}
                    {formData.processTravelDocument && (
                        <Card className="p-6 border-primary-200 bg-primary-50/30">
                            <div className="mb-4 text-center border-b pb-4">
                                <h3 className="text-lg font-bold text-gray-800 uppercase">Local Travel Authorization</h3>
                                <p className="text-xs text-gray-500 mt-1">DOC NO: HR APX – 27 LOCAL TRAVEL AUTHORISATION</p>
                            </div>

                            <div className="space-y-6">
                                {/* Travel Details */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <Input
                                        type="date"
                                        label="Date of Intended Travel *"
                                        value={travelData.dateOfIntendedTravel}
                                        onChange={(e) => setTravelData({ ...travelData, dateOfIntendedTravel: e.target.value })}
                                        required
                                        min={todayISO}
                                    />
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Purpose of Travel <span className="text-danger-500">*</span></label>
                                        <textarea
                                            className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]"
                                            value={travelData.purposeOfTravel}
                                            onChange={(e) => setTravelData({ ...travelData, purposeOfTravel: e.target.value })}
                                            placeholder="Enter purpose of travel"
                                            required
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Accompanying Associates</label>
                                        <textarea
                                            className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]"
                                            value={travelData.accompanyingAssociates}
                                            onChange={(e) => setTravelData({ ...travelData, accompanyingAssociates: e.target.value })}
                                            placeholder="Enter names of accompanying associates (if any)"
                                        />
                                    </div>
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

                                {/* Conditions */}
                                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                                    <h4 className="font-semibold text-amber-800 mb-3 uppercase text-sm">Conditions of Travel</h4>
                                    <ol className="list-decimal list-inside space-y-2 text-sm text-amber-900">
                                        <li>Authorization must be sought using this form at least 7 days prior to departure.</li>
                                        <li>Travel expenses must be claimed within 30 days after completion of travel, otherwise the claim shall be void.</li>
                                        <li>It is an act of misconduct to travel without authority.</li>
                                    </ol>
                                    <div className="mt-4 flex items-center gap-3">
                                        <input
                                            type="checkbox"
                                            id="acceptConditions"
                                            checked={travelData.acceptConditions}
                                            onChange={(e) => setTravelData({ ...travelData, acceptConditions: e.target.checked })}
                                            className="w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                                            required
                                        />
                                        <label htmlFor="acceptConditions" className="text-sm font-medium text-amber-900 cursor-pointer">
                                            I have read these conditions and accept them. <span className="text-danger-500">*</span>
                                        </label>
                                    </div>
                                </div>

                                {/* Emergency Request Warning - Shows when travel is within 7 days */}
                                {isTravelWithin7Days() && (
                                    <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4">
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
                                                    id="isEmergencyRequestHotel"
                                                    checked={isEmergencyRequest}
                                                    onChange={(e) => setIsEmergencyRequest(e.target.checked)}
                                                    className="w-5 h-5 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                                                />
                                                <label htmlFor="isEmergencyRequestHotel" className="text-sm font-semibold text-red-800 cursor-pointer">
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
                                    </div>
                                )}

                                {/* Travel Itinerary */}
                                <div>
                                    <div className="flex items-center justify-between mb-3">
                                        <h4 className="font-semibold text-gray-700 uppercase text-sm">Travel Itinerary <span className="text-danger-500">*</span></h4>
                                        <button type="button" onClick={addItineraryRow} className="text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1">
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
                                            Add Row
                                        </button>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="bg-gray-100">
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Date/Time</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700">From</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700">To</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-20">KM</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Justification</th>
                                                    <th className="px-3 py-2 w-10"></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {travelData.itinerary.map((row, index) => {
                                                    const isFromOther = row.from === 'OTHER';
                                                    const isToOther = row.to === 'OTHER';
                                                    const isManualEntry = isFromOther || isToOther;
                                                    return (
                                                        <tr key={index} className="border-b border-gray-100">
                                                            <td className="px-2 py-2">
                                                                <input type="date" value={row.date} onChange={(e) => updateItineraryRow(index, 'date', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm" />
                                                            </td>
                                                            <td className="px-2 py-2">
                                                                <div className="space-y-1">
                                                                    <select value={row.from} onChange={(e) => updateItineraryRow(index, 'from', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm">
                                                                        <option value="">Select Origin</option>
                                                                        {TRAVEL_LOCATIONS.map(loc => (<option key={loc.code} value={loc.code}>{loc.name}</option>))}
                                                                    </select>
                                                                    {isFromOther && (
                                                                        <input type="text" value={row.fromCustom || ''} onChange={(e) => updateItineraryRow(index, 'fromCustom', e.target.value)} className="w-full px-2 py-1 rounded border border-orange-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm bg-orange-50" placeholder="Enter custom origin" />
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td className="px-2 py-2">
                                                                <div className="space-y-1">
                                                                    <select value={row.to} onChange={(e) => updateItineraryRow(index, 'to', e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 outline-none text-sm">
                                                                        <option value="">Select Destination</option>
                                                                        {TRAVEL_LOCATIONS.map(loc => (<option key={loc.code} value={loc.code}>{loc.name}</option>))}
                                                                    </select>
                                                                    {isToOther && (
                                                                        <input type="text" value={row.toCustom || ''} onChange={(e) => updateItineraryRow(index, 'toCustom', e.target.value)} className="w-full px-2 py-1 rounded border border-orange-300 focus:ring-1 focus:ring-orange-500 outline-none text-sm bg-orange-50" placeholder="Enter custom destination" />
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td className="px-2 py-2">
                                                                <input type="number" value={row.km} readOnly={!isManualEntry} onChange={(e) => isManualEntry && updateItineraryRow(index, 'km', e.target.value)} className={`w-full px-2 py-1 rounded border outline-none text-sm text-center font-medium ${isManualEntry ? 'border-orange-300 bg-orange-50 focus:ring-1 focus:ring-orange-500' : 'border-gray-200 bg-gray-50'}`} placeholder="0" />
                                                            </td>
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
                                                <tr className="bg-primary-50 font-semibold">
                                                    <td colSpan={3} className="px-3 py-2 text-right text-primary-700">Total Distance:</td>
                                                    <td className="px-2 py-2 text-center text-primary-900">{travelData.itinerary.reduce((sum, row) => sum + (parseFloat(row.km) || 0), 0)} km</td>
                                                    <td colSpan={2}></td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>

                                    </div>

                                

                                {/* AA Rates Calculator - Only for Personal Motor Vehicle */}
                                {travelData.travelMode === 'personal_motor_vehicle' && (
                                    <div className="bg-[#F3EADC] border border-[#C9B896] rounded-xl p-4">
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
                                                        onChange={(e) => { setAACalculator({ ...aaCalculator, engineCapacity: e.target.value }); setAaRatesLocked(false); }}
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
                                                        onChange={(e) => { setAACalculator({ ...aaCalculator, fuelType: e.target.value as 'petrol' | 'diesel' }); setAaRatesLocked(false); }}
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

                                            <div className="flex justify-end mt-4">
                                                <button type="button" onClick={applyAARate} className="px-4 py-2 bg-[#9A7545] text-white rounded-lg hover:bg-[#5E4426] transition-colors font-medium text-sm flex items-center gap-2">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" /></svg>
                                                    Apply to Budget
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Travel Budget */}
                                <div>
                                    <h4 className="font-semibold text-gray-700 uppercase text-sm mb-3">Travel Budget <span className="text-danger-500">*</span></h4>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="bg-gray-100">
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Expenditure Item</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-24">Quantity</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-28">Unit Cost (USD)</th>
                                                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-28">Total Cost (USD)</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {travelData.travelMode === 'personal_motor_vehicle' && (
                                                    <tr className={`border-b border-gray-100 ${aaRatesLocked ? 'bg-green-50' : ''}`}>
                                                        <td className="px-3 py-2 text-gray-700">
                                                            Travel Cost (AA Rate × Distance)
                                                            {aaRatesLocked && <span className="ml-2 text-xs text-green-600 font-medium">(Applied)</span>}
                                                        </td>
                                                        <td className="px-2 py-2">
                                                            <input type="number" value={travelData.budget.aaRates.quantity} onChange={(e) => !aaRatesLocked && updateBudgetItem('aaRates', 'quantity', e.target.value)} readOnly={aaRatesLocked} className={`w-full px-2 py-1 rounded border outline-none text-sm ${aaRatesLocked ? 'border-green-200 bg-green-50 text-green-800 font-medium' : 'border-gray-300 focus:ring-1 focus:ring-primary-500'}`} placeholder="0" min="0" />
                                                        </td>
                                                        <td className="px-2 py-2">
                                                            <input type="number" value={travelData.budget.aaRates.unitCost} onChange={(e) => !aaRatesLocked && updateBudgetItem('aaRates', 'unitCost', e.target.value)} readOnly={aaRatesLocked} className={`w-full px-2 py-1 rounded border outline-none text-sm ${aaRatesLocked ? 'border-green-200 bg-green-50 text-green-800 font-medium' : 'border-gray-300 focus:ring-1 focus:ring-primary-500'}`} placeholder="0.28" step="0.01" min="0" />
                                                        </td>
                                                        <td className="px-2 py-2">
                                                            <input type="number" value={travelData.budget.aaRates.totalCost} readOnly className={`w-full px-2 py-1 rounded border outline-none text-sm ${aaRatesLocked ? 'border-green-200 bg-green-50 text-green-800 font-medium' : 'border-gray-200 bg-gray-50'}`} placeholder="0.00" />
                                                        </td>
                                                    </tr>
                                                )}
                                                <tr className="border-b border-gray-100">
                                                    <td className="px-3 py-2 text-gray-700">Air/Bus Tickets</td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.airBusTickets.quantity}
                                                            onChange={(e) => updateBudgetItem('airBusTickets', 'quantity', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.airBusTickets.unitCost}
                                                            onChange={(e) => updateBudgetItem('airBusTickets', 'unitCost', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0.00"
                                                            step="0.01"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.airBusTickets.totalCost}
                                                            readOnly
                                                            className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm"
                                                            placeholder="0.00"
                                                        />
                                                    </td>
                                                </tr>
                                                <tr className="border-b border-gray-100">
                                                    <td className="px-3 py-2 text-gray-700">Overnight Accommodation (b&b)</td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.overnightAccommodation.quantity}
                                                            onChange={(e) => updateBudgetItem('overnightAccommodation', 'quantity', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.overnightAccommodation.unitCost}
                                                            onChange={(e) => updateBudgetItem('overnightAccommodation', 'unitCost', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0.00"
                                                            step="0.01"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.overnightAccommodation.totalCost}
                                                            readOnly
                                                            className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm"
                                                            placeholder="0.00"
                                                        />
                                                    </td>
                                                </tr>
                                                <tr className="border-b border-gray-100">
                                                    <td className="px-3 py-2 text-gray-700">Lunch/Dinner</td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.lunchDinner.quantity}
                                                            onChange={(e) => updateBudgetItem('lunchDinner', 'quantity', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.lunchDinner.unitCost}
                                                            onChange={(e) => updateBudgetItem('lunchDinner', 'unitCost', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0.00"
                                                            step="0.01"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.lunchDinner.totalCost}
                                                            readOnly
                                                            className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm"
                                                            placeholder="0.00"
                                                        />
                                                    </td>
                                                </tr>
                                                <tr className="border-b border-gray-100">
                                                    <td className="px-3 py-2 text-gray-700">Conferencing Cost</td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.conferencingCost.quantity}
                                                            onChange={(e) => updateBudgetItem('conferencingCost', 'quantity', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.conferencingCost.unitCost}
                                                            onChange={(e) => updateBudgetItem('conferencingCost', 'unitCost', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0.00"
                                                            step="0.01"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.conferencingCost.totalCost}
                                                            readOnly
                                                            className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm"
                                                            placeholder="0.00"
                                                        />
                                                    </td>
                                                </tr>
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
                                                                                    name="tollgateRouteTypeHotel"
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
                                                                                    name="tollgateRouteTypeHotel"
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
                                                        {travelData.budget.tollgates.map((toll, idx) => (
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
                                                                    {travelData.budget.tollgates.length > 1 && (
                                                                        <button type="button" onClick={() => removeTollgateRow(idx)} className="text-red-500 hover:text-red-700 p-1">
                                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                        </button>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </>
                                                )}
                                                <tr className="border-b border-gray-100">
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="text"
                                                            value={travelData.budget.other.description}
                                                            onChange={(e) => updateBudgetItem('other', 'description', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="Other (specify)"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.other.quantity}
                                                            onChange={(e) => updateBudgetItem('other', 'quantity', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.other.unitCost}
                                                            onChange={(e) => updateBudgetItem('other', 'unitCost', e.target.value)}
                                                            className="w-full px-2 py-1 rounded border border-gray-300 focus:ring-1 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                                                            placeholder="0.00"
                                                            step="0.01"
                                                            min="0"
                                                        />
                                                    </td>
                                                    <td className="px-2 py-2">
                                                        <input
                                                            type="number"
                                                            value={travelData.budget.other.totalCost}
                                                            readOnly
                                                            className="w-full px-2 py-1 rounded border border-gray-200 bg-gray-50 outline-none text-sm"
                                                            placeholder="0.00"
                                                        />
                                                    </td>
                                                </tr>
                                                <tr className="bg-gray-100 font-semibold">
                                                    <td className="px-3 py-2 text-gray-900" colSpan={3}>GRAND TOTAL</td>
                                                    <td className="px-3 py-2 text-gray-900">USD {calculateGrandTotal()}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Cost Allocation — the requestor ticks the unit(s) that
                                        carry the travel cost. One unit → whole cost. Tick 2+ to
                                        split, which reveals figure inputs + a "fully allocated"
                                        control. Copied from requests/new/travel-auth. */}
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

                                    {/* Supporting documents for the travel authorization */}
                                    <div className="mt-6 pt-6 border-t border-gray-200">
                                        <SupportingDocuments
                                            documents={travelSupportingDocs}
                                            onChange={setTravelSupportingDocs}
                                            helpText="Attach any supporting documents for this travel authorization (e.g. invitations, quotations, itineraries). Give each a short label and description."
                                        />
                                    </div>
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Approval Section - 4 Fixed Roles */}
                    <Card className="p-6">
                        <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2 text-lg">
                            <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Approval Workflow <span className="text-danger-500">*</span>
                        </h3>
                        <p className="text-sm text-text-secondary mb-4">
                            Approvers are automatically assigned from the HRIMS organogram. If a role has no assigned user, you must manually select one.
                        </p>

                        {loadingApproverResolution && <ApproverSectionLoader rows={approvalRoles.length} />}

                        {/* Click outside to close any dropdown */}
                        {showApproverDropdown && (
                            <div
                                className="fixed inset-0 z-10"
                                onClick={() => setShowApproverDropdown(null)}
                            />
                        )}

                        {/* Approval Roles */}
                        <div className={`space-y-4 ${loadingApproverResolution ? 'hidden' : ''}`}>
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);
                                const isAutoResolved = autoResolvedRoles[role.key];
                                const isLocked = isApproverRowLocked(role.key, isAutoResolved);

                                return (
                                    <div key={role.key} className="relative">
                                        <div className="flex items-start gap-4">
                                            {/* Step Number */}
                                            <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 bg-primary-50 border-primary-200 text-primary-600 flex-shrink-0 mt-1">
                                                <span className="font-bold text-sm">{index + 1}</span>
                                            </div>

                                            <div className="flex-1">
                                                {/* Role Label */}
                                                <div className="mb-2">
                                                    <h4 className="font-semibold text-gray-900">{role.label}</h4>
                                                    <p className="text-xs text-gray-500">{role.description}</p>
                                                </div>

                                                {/* Selected User or Search Input */}
                                                {selectedUser ? (
                                                    <div className={`flex items-center gap-3 ${isAutoResolved ? 'bg-green-50 border border-green-200' : 'bg-primary-50 border border-primary-200'} p-3 rounded-xl`}>
                                                        <div className={`w-8 h-8 rounded-full ${isAutoResolved ? 'bg-green-100' : 'bg-primary-100'} flex items-center justify-center flex-shrink-0`}>
                                                            <span className={`text-sm font-medium ${isAutoResolved ? 'text-green-600' : 'text-primary-600'}`}>
                                                                {selectedUser.display_name?.charAt(0)?.toUpperCase() || '?'}
                                                            </span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 truncate">{selectedUser.display_name}</p>
                                                            <p className="text-xs text-gray-500 truncate">{selectedUser.email}</p>
                                                            {isAutoResolved && <p className="text-xs text-green-600 mt-0.5">Auto-assigned from HRIMS organogram{isLocked ? ' · locked' : ''}</p>}
                                                        </div>
                                                        {/* Senior fixed approvers (CEO, HRD, directors) are locked once
                                                            auto-resolved; departmental/managerial rows stay changeable. */}
                                                        {!isLocked && (
                                                        <button
                                                            type="button"
                                                            onClick={() => { handleRemoveApprover(role.key); setAutoResolvedRoles(prev => ({ ...prev, [role.key]: false })); }}
                                                            className="p-1.5 rounded-lg hover:bg-danger-50 text-gray-400 hover:text-danger-500 transition-colors"
                                                            title="Remove approver"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                            </svg>
                                                        </button>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="relative">
                                                        {!loadingApproverResolution && !isEditMode && (
                                                            <p className="text-xs text-amber-600 mb-1">No user found in HRIMS for this role. Please select manually.</p>
                                                        )}
                                                        <div className="relative">
                                                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                                            </svg>
                                                            <input
                                                                type="text"
                                                                className="w-full pl-10 pr-4 py-2 min-h-[44px] rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                                                                placeholder={`Search for ${role.label}...`}
                                                                value={approverSearch[role.key] || ''}
                                                                onChange={(e) => {
                                                                    setApproverSearch(prev => ({ ...prev, [role.key]: e.target.value }));
                                                                    setShowApproverDropdown(role.key);
                                                                }}
                                                                onFocus={() => setShowApproverDropdown(role.key)}
                                                            />
                                                        </div>

                                                        {/* Dropdown Results */}
                                                        {showApproverDropdown === role.key && (
                                                            <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                                                {loadingUsers ? (
                                                                    <div className="flex items-center justify-center py-4">
                                                                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500" />
                                                                    </div>
                                                                ) : filteredUsers.length === 0 ? (
                                                                    <div className="px-4 py-3 text-sm text-gray-500">
                                                                        No users found
                                                                    </div>
                                                                ) : (
                                                                    filteredUsers.slice(0, 10).map((u) => (
                                                                        <button
                                                                            key={u.id}
                                                                            type="button"
                                                                            onClick={() => handleSelectApprover(role.key, u.id)}
                                                                            className="w-full px-4 py-3 text-left hover:bg-primary-50 transition-colors flex items-center gap-3 border-b border-gray-100 last:border-b-0"
                                                                        >
                                                                            <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                                                                <span className="text-sm font-medium text-primary-600">
                                                                                    {u.display_name?.charAt(0)?.toUpperCase() || '?'}
                                                                                </span>
                                                                            </div>
                                                                            <div className="flex-1 min-w-0">
                                                                                <p className="text-sm font-medium text-gray-900 truncate">{u.display_name}</p>
                                                                                <p className="text-xs text-gray-500 truncate">{u.email}</p>
                                                                            </div>
                                                                        </button>
                                                                    ))
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Connecting line between steps */}
                                        {index < approvalRoles.length - 1 && (
                                            <div className="absolute left-5 top-12 bottom-0 w-0.5 bg-gray-200 -mb-4 h-8" style={{ transform: 'translateX(-50%)' }} />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </div>

                {/* Footer Action Bar */}
                <div className="sticky bottom-0 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-100 pb-safe z-10 shadow-lg">
                    <div className="flex gap-3 max-w-5xl mx-auto">
                        {isApproverEditing ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1 shadow-primary-500/25 shadow-lg" isLoading={loading}>Save Changes</Button>
                            </>
                        ) : isEditMode ? (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="submit" variant="primary" className="flex-1 shadow-primary-500/25 shadow-lg" isLoading={loading || savingDraft}>Save Changes</Button>
                            </>
                        ) : (
                            <>
                                <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()}>Cancel</Button>
                                <Button type="button" variant="secondary" className="flex-1 border-primary-300 text-primary-600 hover:bg-primary-50" onClick={handleSaveDraft} isLoading={savingDraft} disabled={loading}>Save as Draft</Button>
                                <Button type="submit" variant="primary" className="flex-1 shadow-primary-500/25 shadow-lg" isLoading={loading} disabled={savingDraft}>Submit Request</Button>
                            </>
                        )}
                    </div>
                </div>
            </form>

            <RequestPreviewModal
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                mode="preview"
                title={formData.processTravelDocument ? 'Complimentary Booking & Travel Authorisation' : 'Complimentary Hotel Staff Booking Form'}
                subtitle={`Requestor: ${requestor.name || ''} · ${today}`}
                sections={buildPreviewSections()}
                documentHeader={hotelBookingDocumentHeader}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title={formData.processTravelDocument ? 'Complimentary Booking & Travel Authorisation' : 'Complimentary Hotel Staff Booking Form'}
                subtitle={`Requestor: ${requestor.name || ''} · ${today}`}
                sections={buildPreviewSections()}
                documentHeader={hotelBookingDocumentHeader}
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
