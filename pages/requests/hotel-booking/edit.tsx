import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input } from '../../../components/ui';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';
import { useOrganizationData } from '../../../hooks/useOrganizationData';

interface SelectedBusinessUnit {
    id: string;
    name: string;
    bookingMade: boolean;
    arrivalDate: string;
    departureDate: string;
    numberOfNights: string;
    numberOfRooms: string;
    accommodationType: string;
    specialArrangements: string;
}

export default function HotelBookingEditPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName } = useUserHrimsProfile();
    const { businessUnits, loading: businessUnitsLoading } = useOrganizationData(user?.organization_id);
    const [loading, setLoading] = useState(false);
    const [savingChanges, setSavingChanges] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedBusinessUnits, setSelectedBusinessUnits] = useState<SelectedBusinessUnit[]>([]);

    // Edit mode state
    const { id: editRequestId, approver: isApproverEdit } = router.query;
    const isApproverEditing = isApproverEdit === 'true';
    const [loadingRequest, setLoadingRequest] = useState(true);
    const [originalData, setOriginalData] = useState<any>(null);

    // Initial date for display
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const [formData, setFormData] = useState({
        guestNames: '',
        isExternalGuest: false,
        allocationType: 'marketing_domestic',
        percentageDiscount: '',
        reason: '',
        processTravelDocument: false,
    });

    // Approver selection state - 4 fixed roles
    const approvalRoles = [
        { key: 'hod', label: 'Head of Department', description: 'Department Approval' },
        { key: 'hr_director', label: 'Chief Human Capital Officer', description: 'HR Review' },
        { key: 'finance_director', label: 'Chief Finance Officer', description: 'Financial Review' },
        { key: 'ceo', label: 'CEO', description: 'Final Authorization' },
    ];
    const [users, setUsers] = useState<Array<{ id: string; display_name: string; email: string; job_title?: string }>>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [selectedApprovers, setSelectedApprovers] = useState<Record<string, string>>({
        hod: '',
        hr_director: '',
        finance_director: '',
        ceo: '',
    });
    const [approverSearch, setApproverSearch] = useState<Record<string, string>>({
        hod: '',
        hr_director: '',
        finance_director: '',
        ceo: '',
    });
    const [showApproverDropdown, setShowApproverDropdown] = useState<string | null>(null);

    // Travel document state
    const [travelData, setTravelData] = useState({
        dateOfIntendedTravel: '',
        purposeOfTravel: '',
        accompanyingAssociates: '',
        travelMode: '',
        acceptConditions: false,
        itinerary: [{ date: '', from: '', to: '', km: '', justification: '' }],
        hotelReservation: '',
        budget: {
            fuel: { quantity: '', unitCost: '', totalCost: '' },
            aaRates: { quantity: '', unitCost: '', totalCost: '' },
            airBusTickets: { quantity: '', unitCost: '', totalCost: '' },
            conferencingCost: { quantity: '', unitCost: '', totalCost: '' },
            tollgates: { quantity: '', unitCost: '', totalCost: '' },
            other: { description: '', quantity: '', unitCost: '', totalCost: '' },
        },
    });

    const addItineraryRow = () => {
        setTravelData(prev => ({
            ...prev,
            itinerary: [...prev.itinerary, { date: '', from: '', to: '', km: '', justification: '' }]
        }));
    };

    const updateItineraryRow = (index: number, field: string, value: string) => {
        setTravelData(prev => ({
            ...prev,
            itinerary: prev.itinerary.map((row, i) => 
                i === index ? { ...row, [field]: value } : row
            )
        }));
    };

    const removeItineraryRow = (index: number) => {
        if (travelData.itinerary.length > 1) {
            setTravelData(prev => ({
                ...prev,
                itinerary: prev.itinerary.filter((_, i) => i !== index)
            }));
        }
    };

    const calculateGrandTotal = () => {
        const budget = travelData.budget;
        const values = [
            budget.fuel.totalCost,
            budget.aaRates.totalCost,
            budget.airBusTickets.totalCost,
            budget.conferencingCost.totalCost,
            budget.tollgates.totalCost,
            budget.other.totalCost,
        ];
        return values.reduce((sum, val) => sum + (parseFloat(val) || 0), 0).toFixed(2);
    };

    const updateBudgetItem = (item: keyof typeof travelData.budget, field: string, value: string) => {
        setTravelData(prev => {
            const currentItem = prev.budget[item];
            const updatedItem = { ...currentItem, [field]: value };
            
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

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

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

    // Fetch existing request data
    useEffect(() => {
        const fetchExistingRequest = async () => {
            if (!editRequestId || typeof editRequestId !== 'string') {
                setLoadingRequest(false);
                return;
            }
            
            setLoadingRequest(true);
            try {
                const response = await fetch(`/api/requests/${editRequestId}`);
                if (!response.ok) {
                    throw new Error('Failed to fetch request');
                }
                
                const data = await response.json();
                const request = data.request;
                const metadata = request.metadata || {};
                
                // Store original data for comparison
                setOriginalData(metadata);
                
                // Populate form data
                setFormData({
                    guestNames: metadata.guestNames || '',
                    isExternalGuest: metadata.isExternalGuest || false,
                    allocationType: metadata.allocationType || 'marketing_domestic',
                    percentageDiscount: metadata.percentageDiscount || '',
                    reason: metadata.reason || '',
                    processTravelDocument: metadata.processTravelDocument || false,
                });
                
                // Populate business units
                if (metadata.selectedBusinessUnits && Array.isArray(metadata.selectedBusinessUnits)) {
                    setSelectedBusinessUnits(metadata.selectedBusinessUnits);
                }
                
                // Populate approvers
                if (metadata.approvers && typeof metadata.approvers === 'object') {
                    setSelectedApprovers(metadata.approvers);
                }
                
                // Populate travel data if exists
                if (metadata.travelDocument) {
                    setTravelData(metadata.travelDocument);
                }
                
            } catch (err: any) {
                setError(err.message || 'Failed to load request');
            } finally {
                setLoadingRequest(false);
            }
        };

        if (status === 'authenticated' && editRequestId) {
            fetchExistingRequest();
        }
    }, [editRequestId, status]);

    // Filter users by search for a specific role
    const getFilteredUsersForRole = (roleKey: string) => {
        const searchTerm = approverSearch[roleKey] || '';
        const alreadySelectedIds = Object.values(selectedApprovers).filter(id => id);
        return users.filter(u => {
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

    const handleBusinessUnitToggle = (unitId: string, unitName: string) => {
        setSelectedBusinessUnits(prev => {
            const exists = prev.find(u => u.id === unitId);
            if (exists) {
                return prev.filter(u => u.id !== unitId);
            }
            return [...prev, {
                id: unitId,
                name: unitName,
                bookingMade: false,
                arrivalDate: '',
                departureDate: '',
                numberOfNights: '',
                numberOfRooms: '',
                accommodationType: 'accommodation_only',
                specialArrangements: 'N/A',
            }];
        });
    };

    const handleBusinessUnitFieldChange = (unitId: string, field: keyof SelectedBusinessUnit, value: string | boolean) => {
        setSelectedBusinessUnits(prev =>
            prev.map(u => {
                if (u.id !== unitId) return u;
                const updated = { ...u, [field]: value };
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

    const handleSaveChanges = async () => {
        if (!editRequestId || typeof editRequestId !== 'string') return;
        
        setSavingChanges(true);
        setError(null);

        try {
            // Collect field changes for modification tracking
            const fieldChanges: { fieldName: string; oldValue: any; newValue: any }[] = [];
            
            // Compare and track changes
            if (originalData) {
                if (formData.guestNames !== originalData.guestNames) {
                    fieldChanges.push({ fieldName: 'guestNames', oldValue: originalData.guestNames, newValue: formData.guestNames });
                }
                if (formData.isExternalGuest !== originalData.isExternalGuest) {
                    fieldChanges.push({ fieldName: 'isExternalGuest', oldValue: originalData.isExternalGuest, newValue: formData.isExternalGuest });
                }
                if (formData.allocationType !== originalData.allocationType) {
                    fieldChanges.push({ fieldName: 'allocationType', oldValue: originalData.allocationType, newValue: formData.allocationType });
                }
                if (formData.percentageDiscount !== originalData.percentageDiscount) {
                    fieldChanges.push({ fieldName: 'percentageDiscount', oldValue: originalData.percentageDiscount, newValue: formData.percentageDiscount });
                }
                if (formData.reason !== originalData.reason) {
                    fieldChanges.push({ fieldName: 'reason', oldValue: originalData.reason, newValue: formData.reason });
                }
                // Compare business units
                if (JSON.stringify(selectedBusinessUnits) !== JSON.stringify(originalData.selectedBusinessUnits)) {
                    fieldChanges.push({ fieldName: 'selectedBusinessUnits', oldValue: originalData.selectedBusinessUnits, newValue: selectedBusinessUnits });
                }
            }

            // Use the approver-edit endpoint if approver is editing
            if (isApproverEditing && fieldChanges.length > 0) {
                const editResponse = await fetch(`/api/requests/${editRequestId}/approver-edit`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        fieldChanges,
                        metadata: {
                            guestNames: formData.guestNames,
                            isExternalGuest: formData.isExternalGuest,
                            selectedBusinessUnits: selectedBusinessUnits,
                            allocationType: formData.allocationType,
                            percentageDiscount: formData.percentageDiscount,
                            reason: formData.reason,
                            processTravelDocument: formData.processTravelDocument,
                            ...(formData.processTravelDocument && { travelDocument: travelData }),
                            approvers: selectedApprovers,
                        },
                    }),
                });

                if (!editResponse.ok) {
                    const errorData = await editResponse.json();
                    throw new Error(errorData.error || 'Failed to save changes');
                }
            } else if (fieldChanges.length > 0) {
                // Regular update for non-approver edits (creator editing draft)
                const updateResponse = await fetch(`/api/requests/${editRequestId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: `Hotel Booking: ${formData.guestNames}`,
                        description: formData.reason,
                        metadata: {
                            guestNames: formData.guestNames,
                            isExternalGuest: formData.isExternalGuest,
                            selectedBusinessUnits: selectedBusinessUnits,
                            allocationType: formData.allocationType,
                            percentageDiscount: formData.percentageDiscount,
                            reason: formData.reason,
                            processTravelDocument: formData.processTravelDocument,
                            ...(formData.processTravelDocument && { travelDocument: travelData }),
                            approvers: selectedApprovers,
                        },
                    }),
                });

                if (!updateResponse.ok) {
                    const errorData = await updateResponse.json();
                    throw new Error(errorData.error || 'Failed to save changes');
                }
            }

            // Navigate back to the request detail page
            router.push(`/requests/comp/${editRequestId}`);
        } catch (err: any) {
            setError(err.message || 'Failed to save changes');
        } finally {
            setSavingChanges(false);
        }
    };

    if (status === 'loading' || loadingRequest) {
        return (
            <AppLayout title="Edit Hotel Booking" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    return (
        <AppLayout title="Edit Hotel Booking" showBack onBack={() => router.back()} hideNav>
            <div className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        Edit Hotel Booking Request
                    </h1>
                    {isApproverEditing && (
                        <p className="text-sm text-primary-600 mt-2">
                            You are editing this request as an approver. Changes will be tracked.
                        </p>
                    )}
                </div>

                {error && (
                    <Card className="mb-4 bg-danger-50 border-danger-200">
                        <p className="text-danger-600 text-sm">{error}</p>
                    </Card>
                )}

                <div className="space-y-6">
                    {/* Requestor Information Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Requestor Information</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Name</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {user?.display_name || session?.user?.name || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Business Unit</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {businessUnitName || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Department</label>
                                <div className="px-4 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600">
                                    {departmentName || 'N/A'}
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

                    {/* Guest Information Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Guest Information</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">
                                    Name(s) of Guest(s) <span className="text-danger-500">*</span>
                                </label>
                                <Input
                                    value={formData.guestNames}
                                    onChange={(e) => setFormData(prev => ({ ...prev, guestNames: e.target.value }))}
                                    placeholder="Enter guest name(s)"
                                />
                            </div>
                            <div className="flex items-center gap-3">
                                <input
                                    type="checkbox"
                                    id="isExternalGuest"
                                    checked={formData.isExternalGuest}
                                    onChange={(e) => setFormData(prev => ({ ...prev, isExternalGuest: e.target.checked }))}
                                    className="w-5 h-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                                <label htmlFor="isExternalGuest" className="text-sm text-gray-700">
                                    External Guest (not a staff member)
                                </label>
                            </div>
                        </div>
                    </Card>

                    {/* Business Unit Selection */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">
                            Select Business Unit(s) <span className="text-danger-500">*</span>
                        </h3>
                        {businessUnitsLoading ? (
                            <div className="flex items-center justify-center py-8">
                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500" />
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                    {businessUnits.map((unit) => {
                                        const isSelected = selectedBusinessUnits.some(u => u.id === unit.id);
                                        return (
                                            <button
                                                key={unit.id}
                                                type="button"
                                                onClick={() => handleBusinessUnitToggle(unit.id, unit.name)}
                                                className={`p-3 rounded-xl border-2 text-left transition-all ${
                                                    isSelected
                                                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                                                        : 'border-gray-200 hover:border-gray-300 text-gray-700'
                                                }`}
                                            >
                                                <div className="font-medium text-sm">{unit.name}</div>
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Selected Business Units Details */}
                                {selectedBusinessUnits.map((unit) => (
                                    <Card key={unit.id} className="p-4 bg-gray-50 border-gray-200">
                                        <h4 className="font-semibold text-gray-800 mb-4">{unit.name}</h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                            <div>
                                                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">
                                                    Arrival Date <span className="text-danger-500">*</span>
                                                </label>
                                                <input
                                                    type="date"
                                                    value={unit.arrivalDate}
                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'arrivalDate', e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">
                                                    Departure Date <span className="text-danger-500">*</span>
                                                </label>
                                                <input
                                                    type="date"
                                                    value={unit.departureDate}
                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'departureDate', e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">
                                                    No. of Nights
                                                </label>
                                                <input
                                                    type="text"
                                                    value={unit.numberOfNights}
                                                    readOnly
                                                    className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-gray-100 text-gray-600"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">
                                                    No. of Rooms <span className="text-danger-500">*</span>
                                                </label>
                                                <input
                                                    type="number"
                                                    min="1"
                                                    value={unit.numberOfRooms}
                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'numberOfRooms', e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">
                                                    Accommodation Type <span className="text-danger-500">*</span>
                                                </label>
                                                <select
                                                    value={unit.accommodationType}
                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'accommodationType', e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                                >
                                                    <option value="accommodation_only">Accommodation Only (Bed only)</option>
                                                    <option value="accommodation_and_breakfast">Bed & Breakfast</option>
                                                    <option value="accommodation_and_meals">Accommodation & Meals</option>
                                                    <option value="accommodation_meals_drink">Accommodation, Meals & Soft Drink</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">
                                                    Special Arrangements
                                                </label>
                                                <input
                                                    type="text"
                                                    value={unit.specialArrangements}
                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'specialArrangements', e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                                />
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="checkbox"
                                                    id={`bookingMade-${unit.id}`}
                                                    checked={unit.bookingMade}
                                                    onChange={(e) => handleBusinessUnitFieldChange(unit.id, 'bookingMade', e.target.checked)}
                                                    className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                                />
                                                <label htmlFor={`bookingMade-${unit.id}`} className="text-sm text-gray-700">
                                                    Booking Made
                                                </label>
                                            </div>
                                        </div>
                                    </Card>
                                ))}
                            </div>
                        )}
                    </Card>

                    {/* Allocation & Discount Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Allocation & Discount</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">Allocation Type</label>
                                <select
                                    value={formData.allocationType}
                                    onChange={(e) => setFormData(prev => ({ ...prev, allocationType: e.target.value }))}
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                >
                                    <option value="marketing_domestic">Marketing – Domestic</option>
                                    <option value="marketing_international">Marketing – International</option>
                                    <option value="administration">Administration</option>
                                    <option value="promotions">Promotions</option>
                                    <option value="personnel">Personnel</option>
                                    <option value="legal">Legal</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">Percentage Discount (%)</label>
                                <Input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={formData.percentageDiscount}
                                    onChange={(e) => setFormData(prev => ({ ...prev, percentageDiscount: e.target.value }))}
                                    placeholder="e.g., 50"
                                />
                            </div>
                        </div>
                    </Card>

                    {/* Reason Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">
                            Reason for Complimentary <span className="text-danger-500">*</span>
                        </h3>
                        <textarea
                            value={formData.reason}
                            onChange={(e) => setFormData(prev => ({ ...prev, reason: e.target.value }))}
                            placeholder="Provide a detailed reason for this complimentary booking request..."
                            rows={4}
                            className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                        />
                    </Card>

                    {/* Approvers Section - Read Only for Approver Edit */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2 flex items-center gap-2">
                            <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Approvers
                        </h3>
                        {isApproverEditing ? (
                            <p className="text-sm text-gray-500 mb-4">Approvers cannot be changed during approver edit.</p>
                        ) : null}
                        <div className="space-y-4">
                            {approvalRoles.map((role, index) => {
                                const selectedUserId = selectedApprovers[role.key];
                                const selectedUser = selectedUserId ? users.find(u => u.id === selectedUserId) : null;
                                const filteredUsers = getFilteredUsersForRole(role.key);

                                return (
                                    <div key={role.key} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
                                        <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-sm">
                                            {index + 1}
                                        </div>
                                        <div className="flex-1">
                                            <div className="font-medium text-gray-800">{role.label}</div>
                                            <div className="text-xs text-gray-500">{role.description}</div>
                                        </div>
                                        <div className="w-64 relative">
                                            {selectedUser ? (
                                                <div className="flex items-center justify-between px-3 py-2 bg-white rounded-lg border border-gray-200">
                                                    <div>
                                                        <div className="text-sm font-medium text-gray-800">{selectedUser.display_name}</div>
                                                        <div className="text-xs text-gray-500">{selectedUser.email}</div>
                                                    </div>
                                                    {!isApproverEditing && (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveApprover(role.key)}
                                                            className="text-gray-400 hover:text-danger-500"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                                            </svg>
                                                        </button>
                                                    )}
                                                </div>
                                            ) : (
                                                <div className="relative">
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
                                                        disabled={isApproverEditing}
                                                    />
                                                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                                    </svg>
                                                    {showApproverDropdown === role.key && filteredUsers.length > 0 && !isApproverEditing && (
                                                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                                                            {filteredUsers.map(u => (
                                                                <button
                                                                    key={u.id}
                                                                    type="button"
                                                                    onClick={() => handleSelectApprover(role.key, u.id)}
                                                                    className="w-full px-4 py-2 text-left hover:bg-gray-50 flex flex-col"
                                                                >
                                                                    <span className="text-sm font-medium text-gray-800">{u.display_name}</span>
                                                                    <span className="text-xs text-gray-500">{u.email}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </div>

                {/* Fixed Bottom Action Bar */}
                <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 shadow-lg z-50">
                    <div className="max-w-5xl mx-auto flex items-center justify-between">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => router.back()}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            onClick={handleSaveChanges}
                            disabled={savingChanges}
                            isLoading={savingChanges}
                        >
                            {savingChanges ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </div>
                </div>
            </div>
        </AppLayout>
    );
}
