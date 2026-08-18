import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewModal, UnsavedChangesModal } from '../../../components/ui';
import type { PreviewSection, DocumentHeader } from '../../../components/ui';
import { useUnsavedChangesPrompt, useFormAutosave } from '../../../hooks';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useUserHrimsProfile } from '../../../hooks/useUserHrimsProfile';

const ACCOMMODATION_LABELS: Record<string, string> = {
    accommodation_only: 'Accommodation Only (Bed only)',
    accommodation_and_breakfast: 'Accommodation + Breakfast',
    accommodation_and_meals: 'Accommodation + Meals',
    accommodation_meals_drink: 'Accommodation + Meals + 1 Soft Drink/Meal',
};
const ALLOCATION_LABELS: Record<string, string> = {
    marketing_domestic: 'Marketing – Domestic',
    marketing_international: 'Marketing – International',
    administration: 'Administration',
    promotions: 'Promotions',
    personnel: 'Personnel',
    legal: 'Legal',
};

export default function ExternalHotelBookingPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const { user } = useCurrentUser();
    const { departmentName, businessUnitName } = useUserHrimsProfile();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Initial date for display
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const [formData, setFormData] = useState({
        hotelUnit: 'Zambezi River Lodge',
        guestNames: '',
        telBookingMade: false,
        arrivalDate: '',
        departureDate: '',
        numberOfNights: '',
        numberOfRooms: '',
        accommodationType: 'accommodation_only',
        allocationType: 'marketing_domestic',
        percentageDiscount: '',
        specialArrangements: 'N/A',
        reason: '',
        processTravelDocument: false,
    });

    // Unsaved-changes tracking — flipped true on first real user interaction via form onChange.
    const [isDirty, setIsDirty] = useState(false);
    const unsavedPrompt = useUnsavedChangesPrompt({ isDirty, disabled: loading });

    // Autosave / crash recovery (serializable slices only).
    useFormAutosave({
        formKey: 'external-hotel-booking',
        data: { formData },
        onRestore: (saved) => {
            if (saved.formData) setFormData(saved.formData);
            setIsDirty(true);
        },
    });

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

    // Calculate nights automatically
    useEffect(() => {
        if (formData.arrivalDate && formData.departureDate) {
            const start = new Date(formData.arrivalDate);
            const end = new Date(formData.departureDate);
            const diffTime = Math.abs(end.getTime() - start.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            setFormData(prev => ({ ...prev, numberOfNights: diffDays.toString() }));
        }
    }, [formData.arrivalDate, formData.departureDate]);

    const [showPreview, setShowPreview] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    // Shared inline styles so the preview and the printed HTML look the same.
    const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11 };
    const cellStyle: React.CSSProperties = { border: '1px solid #333', padding: '6px 8px', verticalAlign: 'top' };
    const headCellStyle: React.CSSProperties = { ...cellStyle, background: '#F3EADC', color: '#5E4426', fontWeight: 700, textAlign: 'left' };
    const labelCellStyle: React.CSSProperties = { ...cellStyle, background: '#FAF7F0', fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em', width: '22%' };

    const approvalColumns = [
        { key: 'line_manager', label: 'Line Manager', description: 'Recommendation' },
        { key: 'functional_head', label: 'Functional Head', description: 'Functional Approval' },
        { key: 'hrd', label: 'Chief Human Capital Officer', description: 'CHCO Approval' },
        { key: 'ceo', label: 'CEO', description: 'Authorisation' },
    ];

    const externalHotelDocumentHeader: DocumentHeader = {
        logoUrl: '/images/RTG_LOGO.png',
        docNo: 'DOC NO. FIN 101',
        department: 'DEPARTMENT: FINANCE',
        page: 'PAGE: 1 of 1',
    };

    const buildPreviewSections = (): PreviewSection[] => {
        const requestTimestamp = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const requestorName = user?.display_name || session?.user?.name || '—';

        return [
            // Main form header section — table layout
            {
                content: (
                    <table className="doc-grid" style={tableStyle}>
                        <tbody>
                            <tr>
                                <td style={labelCellStyle}>Name of Employee</td>
                                <td style={cellStyle}>{requestorName}</td>
                                <td style={labelCellStyle}>Department</td>
                                <td style={cellStyle}>{departmentName || '—'}</td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Date &amp; Time of Request</td>
                                <td style={cellStyle}>{requestTimestamp}</td>
                                <td style={labelCellStyle}>Business Unit</td>
                                <td style={cellStyle}>{businessUnitName || formData.hotelUnit || '—'}</td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Guest Details</td>
                                <td style={cellStyle} colSpan={3}>{formData.guestNames || '—'}</td>
                            </tr>
                            <tr>
                                <td style={labelCellStyle}>Booking Already Made</td>
                                <td style={cellStyle} colSpan={3}>{formData.telBookingMade ? 'Yes' : 'No'}</td>
                            </tr>
                        </tbody>
                    </table>
                ),
            },
            // Business unit and booking details grid table
            {
                title: 'Business Unit and Booking Details',
                content: (
                    <table className="doc-grid" style={tableStyle}>
                        <thead>
                            <tr>
                                <th style={headCellStyle}>Hotel Unit</th>
                                <th style={headCellStyle}>Arrival Date</th>
                                <th style={headCellStyle}>Departure Date</th>
                                <th style={{ ...headCellStyle, textAlign: 'right', width: '8%' }}>Nights</th>
                                <th style={{ ...headCellStyle, textAlign: 'right', width: '8%' }}>Rooms</th>
                                <th style={headCellStyle}>Accommodation Type</th>
                                <th style={headCellStyle}>Special Arrangements</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style={cellStyle}>{formData.hotelUnit || '—'}</td>
                                <td style={cellStyle}>{formData.arrivalDate || '—'}</td>
                                <td style={cellStyle}>{formData.departureDate || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{formData.numberOfNights || '—'}</td>
                                <td style={{ ...cellStyle, textAlign: 'right' }}>{formData.numberOfRooms || '—'}</td>
                                <td style={cellStyle}>{ACCOMMODATION_LABELS[formData.accommodationType] || formData.accommodationType || '—'}</td>
                                <td style={cellStyle}>{formData.specialArrangements || '—'}</td>
                            </tr>
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
                                <td style={cellStyle}>{ALLOCATION_LABELS[formData.allocationType] || formData.allocationType || '—'}</td>
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
            // Approval section — multi-column horizontal
            {
                title: 'Approval',
                content: (
                    <table className="doc-grid approval-row" style={tableStyle}>
                        <thead>
                            <tr>
                                {approvalColumns.map(r => (
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
                                {approvalColumns.map(r => (
                                    <td key={r.key} style={{ ...cellStyle, width: '25%' }}>
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#555', textTransform: 'uppercase' }}>Name</div>
                                        <div style={{ fontSize: 11, marginBottom: 8 }}>&nbsp;</div>
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
                                ))}
                            </tr>
                        </tbody>
                    </table>
                ),
            },
        ];
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setShowConfirm(true);
    };

    const performSubmit = async () => {
        setLoading(true);

        try {
            setError(null);

            const title = formData.guestNames?.trim()
                ? `External Guest Hotel Booking: ${formData.guestNames.trim().split('\n')[0]}`
                : 'External Guest Hotel Booking Request';

            const response = await fetch('/api/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title,
                    description: formData.reason,
                    priority: 'normal',
                    category: 'hotel_booking',
                    type: 'external_hotel_booking',
                    metadata: {
                        hotelBooking: formData,
                    },
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data?.error || 'Failed to create hotel booking request');
            }

            router.push('/requests/all');
        } catch (err: any) {
            setError(err.message || 'Failed to create hotel booking request');
        } finally {
            setLoading(false);
        }
    };

    if (status === 'loading') {
        return (
            <AppLayout title="External Guest Hotel Booking" showBack onBack={() => router.back()}>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
                </div>
            </AppLayout>
        );
    }

    if (!session) return null;

    return (
        <AppLayout title="External Guest Hotel Booking" showBack onBack={() => router.back()} hideNav>
            <form onSubmit={handleSubmit} onChange={() => setIsDirty(true)} className="p-4 sm:p-6 max-w-5xl mx-auto pb-32">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold text-text-primary font-heading uppercase tracking-wide">
                        External Complimentary Hotel Booking Form
                    </h1>
                    <p className="text-gray-500 mt-2">DOC NO: HR APX – 2 EXTERNAL GUEST BOOKING</p>
                </div>

                {error && (
                    <Card className="mb-4 bg-danger-50 border-danger-200">
                        <p className="text-danger-600 text-sm">{error}</p>
                    </Card>
                )}

                <div className="space-y-6">
                    {/* Hotel Reservation Section */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Hotel Reservation</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Hotel Unit</label>
                                <select
                                    className="w-full px-4 py-2 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                                    value={formData.hotelUnit}
                                    onChange={(e) => setFormData({ ...formData, hotelUnit: e.target.value })}
                                >
                                    <option value="Corporate Office">Corporate Office</option>
                                    <option value="Rainbow Towers Hotel">Rainbow Towers Hotel</option>
                                    <option value="New Ambassador Hotel">New Ambassador Hotel</option>
                                    <option value="Kadoma Hotel and Conferencing Centre">Kadoma Hotel and Conferencing Centre</option>
                                    <option value="Bulawayo Rainbow Hotel">Bulawayo Rainbow Hotel</option>
                                    <option value="Montclair Hotel and Conferencing">Montclair Hotel and Conferencing</option>
                                    <option value="Victoria Falls Rainbow Hotel">Corporate Office</option>
                                    <option value="Azambezi River Lodge">Azambezi River Lodge</option>
                                    {/* <option value="Elephant Hills Resort">Elephant Hills Resort</option>  */}
                                </select>
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
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Guest Name(s)</label>
                                <textarea
                                    className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[80px]"
                                    placeholder="Enter full names of all guests"
                                    value={formData.guestNames}
                                    onChange={(e) => setFormData({ ...formData, guestNames: e.target.value })}
                                    required
                                />
                            </div>

                            <div className="flex items-center gap-4 bg-gray-50 p-4 rounded-xl border border-gray-100">
                                <span className="text-sm font-semibold text-gray-700 uppercase">Tel / Telex / Booking Already Made?</span>
                                <div className="flex gap-6">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="bookingMade"
                                            checked={formData.telBookingMade === true}
                                            onChange={() => setFormData({ ...formData, telBookingMade: true })}
                                            className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                        />
                                        <span className="font-medium text-gray-900">Yes</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="bookingMade"
                                            checked={formData.telBookingMade === false}
                                            onChange={() => setFormData({ ...formData, telBookingMade: false })}
                                            className="w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                        />
                                        <span className="font-medium text-gray-900">No</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Stay Section */}
                    <Card className="p-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <Input
                                type="date"
                                label="Arrival Date"
                                value={formData.arrivalDate}
                                onChange={(e) => setFormData({ ...formData, arrivalDate: e.target.value })}
                                required
                            />
                            <Input
                                type="number"
                                label="No. Of Nights"
                                value={formData.numberOfNights}
                                onChange={(e) => setFormData({ ...formData, numberOfNights: e.target.value })}
                                placeholder="Auto-calculated"
                                readOnly
                                className="bg-gray-50"
                            />
                            <Input
                                type="date"
                                label="Departure Date"
                                value={formData.departureDate}
                                onChange={(e) => setFormData({ ...formData, departureDate: e.target.value })}
                                required
                            />
                            <Input
                                type="number"
                                label="No. Of Rooms"
                                value={formData.numberOfRooms}
                                onChange={(e) => setFormData({ ...formData, numberOfRooms: e.target.value })}
                                required
                                min="1"
                            />
                        </div>
                    </Card>

                    {/* Accommodation Type */}
                    <Card className="p-6">
                        <h3 className="text-sm font-semibold text-gray-700 mb-4 uppercase border-b pb-2">Accommodation Type</h3>
                        <div className="space-y-4">
                            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200">
                                <input
                                    type="radio"
                                    name="accommodationType"
                                    value="accommodation_only"
                                    checked={formData.accommodationType === 'accommodation_only'}
                                    onChange={(e) => setFormData({ ...formData, accommodationType: e.target.value })}
                                    className="mt-1 w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                />
                                <div>
                                    <span className="font-bold text-gray-900 block">ACCOMMODATION ONLY</span>
                                    <span className="text-sm text-gray-500">(Bed only)</span>
                                </div>
                            </label>

                            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200">
                                <input
                                    type="radio"
                                    name="accommodationType"
                                    value="accommodation_and_breakfast"
                                    checked={formData.accommodationType === 'accommodation_and_breakfast'}
                                    onChange={(e) => setFormData({ ...formData, accommodationType: e.target.value })}
                                    className="mt-1 w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                />
                                <div>
                                    <span className="font-bold text-gray-900 block">ACCOMMODATION</span>
                                    <span className="text-sm text-gray-500">(Bed and breakfast free. All other food & beverages to be paid for on departure)</span>
                                </div>
                            </label>

                            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200">
                                <input
                                    type="radio"
                                    name="accommodationType"
                                    value="accommodation_and_meals"
                                    checked={formData.accommodationType === 'accommodation_and_meals'}
                                    onChange={(e) => setFormData({ ...formData, accommodationType: e.target.value })}
                                    className="mt-1 w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                />
                                <div>
                                    <span className="font-bold text-gray-900 block">ACCOMMODATION AND MEALS</span>
                                    <span className="text-sm text-gray-500">(Beverages to be paid for on departure)</span>
                                </div>
                            </label>

                            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200">
                                <input
                                    type="radio"
                                    name="accommodationType"
                                    value="accommodation_meals_drink"
                                    checked={formData.accommodationType === 'accommodation_meals_drink'}
                                    onChange={(e) => setFormData({ ...formData, accommodationType: e.target.value })}
                                    className="mt-1 w-4 h-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                                />
                                <div>
                                    <span className="font-bold text-gray-900 block">ACCOMMODATION AND MEALS PLUS ONE SOFT DRINK PER MEAL</span>
                                </div>
                            </label>
                        </div>
                    </Card>

                    {/* Allocation */}
                    <Card className="p-6">
                        <label className="block text-sm font-semibold text-gray-700 mb-3 uppercase">Allocation of Comp Booking</label>
                        <select
                            className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all appearance-none"
                            value={formData.allocationType}
                            onChange={(e) => setFormData({ ...formData, allocationType: e.target.value })}
                        >
                            <option value="marketing_domestic">Marketing – Domestic</option>
                            <option value="marketing_international">Marketing – International</option>
                            <option value="administration">Administration</option>
                            <option value="promotions">Promotions</option>
                            <option value="personnel">Personnel</option>
                            <option value="legal">Legal</option>
                        </select>
                    </Card>

                    {/* Details */}
                    <Card className="p-6 space-y-6">
                        <div>
                            <Input
                                label="Percentage Discount (On accommodation only)"
                                placeholder="%"
                                type="number"
                                min="0"
                                max="100"
                                value={formData.percentageDiscount}
                                onChange={(e) => setFormData({ ...formData, percentageDiscount: e.target.value })}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Special Arrangements</label>
                            <textarea
                                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all resize-none min-h-[60px]"
                                value={formData.specialArrangements}
                                onChange={(e) => setFormData({ ...formData, specialArrangements: e.target.value })}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1 uppercase">Reason for complimentary</label>
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
                                onChange={(e) => setFormData({ ...formData, processTravelDocument: e.target.checked })}
                                className="mt-1 w-5 h-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded cursor-pointer"
                            />
                            <label htmlFor="processTravelDocument" className="cursor-pointer">
                                <span className="font-semibold text-gray-900 block">Process Travel Document</span>
                                <span className="text-sm text-gray-500 mt-1 block">
                                    Check this box if you would like to process your travel authorization document along with this booking request.
                                </span>
                            </label>
                        </div>
                    </Card>

                    {/* Approval Workflow Visualization */}
                    <Card className="p-6 bg-gray-50/50 border-dashed">
                        <h3 className="text-sm font-bold text-gray-400 uppercase mb-6 text-center">Approval Workflow</h3>

                        <div className="flex flex-col md:flex-row items-center justify-between gap-4 max-w-5xl mx-auto relative px-4">
                            {/* Connecting Line (Desktop) */}
                            <div className="hidden md:block absolute top-[28px] left-[5%] right-[5%] h-0.5 bg-gray-200 -z-0" />

                            {/* Step 1: HOD */}
                            <div className="flex flex-col items-center z-10 w-full md:w-auto">
                                <div className="w-14 h-14 rounded-full bg-white border-2 border-primary-100 text-primary-600 flex items-center justify-center font-bold mb-3 shadow-sm">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                    </svg>
                                </div>
                                <span className="font-semibold text-gray-900 text-center">H.O.D</span>
                                <span className="text-xs text-gray-500 text-center mt-1">Approval</span>
                            </div>

                            {/* Arrow 1 */}
                            <div className="text-gray-300 md:-mx-4 transform rotate-90 md:rotate-0 z-10 bg-gray-50/50 p-1">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                                </svg>
                            </div>

                            {/* Step 2: HRD (Keeping HRD for consistency or removing? Prompt says "exact replica of the complimentary hotel booking form (without the travel one)". The complimentary form HAS HRD. So I will keep HRD.) */}
                            <div className="flex flex-col items-center z-10 w-full md:w-auto">
                                <div className="w-14 h-14 rounded-full bg-white border-2 border-primary-100 text-primary-600 flex items-center justify-center font-bold mb-3 shadow-sm">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                    </svg>
                                </div>
                                <span className="font-semibold text-gray-900 text-center">Chief Human Capital Officer</span>
                                <span className="text-xs text-gray-500 text-center mt-1">Approval</span>
                            </div>

                            {/* Arrow 1 */}
                            <div className="text-gray-300 md:-mx-4 transform rotate-90 md:rotate-0 z-10 bg-gray-50/50 p-1">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                                </svg>
                            </div>

                            {/* Step 3: Finance Director */}
                            <div className="flex flex-col items-center z-10 w-full md:w-auto">
                                <div className="w-14 h-14 rounded-full bg-white border-2 border-primary-100 text-primary-600 flex items-center justify-center font-bold mb-3 shadow-sm">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                </div>
                                <span className="font-semibold text-gray-900 text-center">Finance Director</span>
                                <span className="text-xs text-gray-500 text-center mt-1">Approval</span>
                            </div>

                            {/* Arrow 3 */}
                            <div className="text-gray-300 md:-mx-4 transform rotate-90 md:rotate-0 z-10 bg-gray-50/50 p-1">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                                </svg>
                            </div>

                            {/* Step 4: CEO */}
                            <div className="flex flex-col items-center z-10 w-full md:w-auto">
                                <div className="w-14 h-14 rounded-full bg-white border-2 border-primary-100 text-primary-600 flex items-center justify-center font-bold mb-3 shadow-sm">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                </div>
                                <span className="font-semibold text-gray-900 text-center">Chief Executive</span>
                                <span className="text-xs text-gray-500 text-center mt-1">Authorisation</span>
                            </div>
                        </div>
                    </Card>
                </div>

                {/* Footer Action Bar */}
                <div className="sticky bottom-0 p-4 bg-white/95 backdrop-blur-sm border-t border-gray-100 pb-safe z-10 shadow-lg">
                    <div className="flex gap-3 max-w-5xl mx-auto">
                        <Button
                            type="button"
                            variant="secondary"
                            className="flex-1"
                            onClick={() => router.back()}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            className="flex-1 shadow-primary-500/25 shadow-lg"
                            isLoading={loading}
                        >
                            Submit Request
                        </Button>
                    </div>
                </div>
            </form>

            <RequestPreviewModal
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                mode="preview"
                title="External Complimentary Hotel Booking Form"
                subtitle={`Date: ${today}`}
                sections={buildPreviewSections()}
                documentHeader={externalHotelDocumentHeader}
            />
            <RequestPreviewModal
                isOpen={showConfirm}
                onClose={() => setShowConfirm(false)}
                mode="confirm"
                title="External Complimentary Hotel Booking Form"
                subtitle={`Date: ${today}`}
                sections={buildPreviewSections()}
                documentHeader={externalHotelDocumentHeader}
                confirming={loading}
                onConfirm={async () => {
                    setShowConfirm(false);
                    await performSubmit();
                }}
            />
            <UnsavedChangesModal
                isOpen={unsavedPrompt.isOpen}
                canSaveDraft={false}
                onSaveDraft={() => {}}
                onDiscard={unsavedPrompt.discardAndContinue}
                onCancel={unsavedPrompt.cancel}
            />
        </AppLayout>
    );
}
