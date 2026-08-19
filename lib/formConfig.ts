/**
 * Form Configuration System
 * 
 * This module provides a registry for form types and their field configurations.
 * When creating a new form, add its configuration here to automatically enable
 * proper display in the request details page.
 */

// Field types for rendering
export type FieldType = 
    | 'text' 
    | 'textarea' 
    | 'number' 
    | 'currency' 
    | 'date' 
    | 'boolean' 
    | 'select' 
    | 'array' 
    | 'object'
    | 'table'
    | 'budget';

// Field display configuration
export interface FieldConfig {
    key: string;
    label: string;
    type: FieldType;
    // For select fields, provide options mapping
    options?: Record<string, string>;
    // For currency fields, specify the currency field key
    currencyKey?: string;
    // For array/table fields, specify nested field configs
    nestedFields?: FieldConfig[];
    // For grouping fields into sections
    section?: string;
    // Column span (1 or 2 for full width)
    colSpan?: 1 | 2;
    // Whether to hide if empty
    hideIfEmpty?: boolean;
    // Custom formatter function name
    formatter?: string;
    // For budget fields, specify the budget items
    budgetItems?: { key: string; label: string; descriptionKey?: string }[];
}

// Section configuration for grouping fields
export interface SectionConfig {
    key: string;
    title: string;
    icon?: string;
    bgColor?: string;
    borderColor?: string;
    headerBgColor?: string;
}

// Complete form type configuration
export interface FormTypeConfig {
    type: string;
    displayName: string;
    // Primary display field (shown prominently at top)
    primaryField?: string;
    // Secondary info shown alongside primary
    secondaryFields?: string[];
    // Badge field (e.g., isExternalGuest)
    badgeField?: { key: string; trueLabel: string; falseLabel: string; trueColor: string; falseColor: string };
    // Sections for organizing fields
    sections: SectionConfig[];
    // All field configurations
    fields: FieldConfig[];
    // Fields to exclude from generic rendering (handled specially)
    excludeFromGeneric?: string[];
}

// ============ FORM TYPE CONFIGURATIONS ============

export const formConfigs: Record<string, FormTypeConfig> = {
    // Hotel Booking Form Configuration
    hotel_booking: {
        type: 'hotel_booking',
        displayName: 'Hotel Booking',
        primaryField: 'guestNames',
        secondaryFields: ['allocationType'],
        badgeField: {
            key: 'isExternalGuest',
            trueLabel: 'External Guest',
            falseLabel: 'Staff Member',
            trueColor: 'amber',
            falseColor: 'emerald',
        },
        sections: [
            { key: 'guest', title: 'Guest Information', bgColor: 'primary-50', borderColor: 'primary-100' },
            { key: 'booking', title: 'Booking Details', bgColor: 'gray-50', borderColor: 'gray-200' },
            { key: 'businessUnits', title: 'Business Units', icon: 'building', bgColor: 'emerald-50', borderColor: 'emerald-100' },
            { key: 'travel', title: 'Local Travel Authorization', icon: 'document', bgColor: 'blue-50', borderColor: 'blue-100' },
        ],
        fields: [
            { key: 'guestNames', label: 'Guest Names', type: 'text', section: 'guest' },
            { key: 'isExternalGuest', label: 'Guest Type', type: 'boolean', section: 'guest' },
            { key: 'allocationType', label: 'Allocation Type', type: 'select', section: 'guest', options: {
                marketing_domestic: 'Marketing – Domestic',
                marketing_international: 'Marketing – International',
                administration: 'Administration',
                promotions: 'Promotions',
                personnel: 'Personnel',
                legal: 'Legal',
            }},
            { key: 'percentageDiscount', label: 'Percentage Discount', type: 'number', section: 'booking', formatter: 'percentage' },
            { key: 'reason', label: 'Reason for Complimentary', type: 'textarea', section: 'booking', colSpan: 2 },
            { key: 'selectedBusinessUnits', label: 'Business Units', type: 'array', section: 'businessUnits', nestedFields: [
                { key: 'name', label: 'Business Unit', type: 'text' },
                { key: 'arrivalDate', label: 'Arrival Date', type: 'date' },
                { key: 'departureDate', label: 'Departure Date', type: 'date' },
                { key: 'numberOfNights', label: 'No. of Nights', type: 'number' },
                { key: 'numberOfRooms', label: 'No. of Rooms', type: 'number' },
                { key: 'accommodationType', label: 'Accommodation Type', type: 'select', options: {
                    accommodation_only: 'Accommodation Only (Bed only)',
                    accommodation_and_breakfast: 'Bed & Breakfast',
                    accommodation_and_meals: 'Accommodation & Meals',
                    accommodation_meals_drink: 'Accommodation, Meals & Soft Drink',
                }},
                { key: 'specialArrangements', label: 'Special Arrangements', type: 'text' },
                { key: 'bookingMade', label: 'Booking Made', type: 'boolean' },
            ]},
            // Travel document fields (conditional on processTravelDocument)
            { key: 'travelDocument', label: 'Travel Document', type: 'object', section: 'travel', nestedFields: [
                { key: 'dateOfIntendedTravel', label: 'Date of Intended Travel', type: 'date' },
                { key: 'travelMode', label: 'Travel Mode', type: 'text' },
                { key: 'purposeOfTravel', label: 'Purpose of Travel', type: 'textarea', colSpan: 2 },
                { key: 'accompanyingAssociates', label: 'Accompanying Associates', type: 'textarea', colSpan: 2 },
                { key: 'itinerary', label: 'Travel Itinerary', type: 'table', nestedFields: [
                    { key: 'date', label: 'Date', type: 'date' },
                    { key: 'from', label: 'From', type: 'text' },
                    { key: 'to', label: 'To', type: 'text' },
                    { key: 'km', label: 'KM', type: 'number' },
                    { key: 'justification', label: 'Justification', type: 'text' },
                ]},
                { key: 'budget', label: 'Travel Budget', type: 'budget', budgetItems: [
                    { key: 'fuel', label: 'Fuel (Indicate Total litres)' },
                    { key: 'aaRates', label: 'AA Rates (Indicate Total Mileage)' },
                    { key: 'airBusTickets', label: 'Air/Bus Tickets' },
                    { key: 'b&b', label: 'Overnight Accommodation (b&b)' },
                    { key: 'lunchDinner', label: 'Lunch/Dinner' },
                    { key: 'conferencingCost', label: 'Conferencing Cost' },
                    { key: 'tollgates', label: 'Tollgates' },
                    { key: 'other', label: 'Other', descriptionKey: 'description' }
                ]},
            ]},
        ],
        excludeFromGeneric: ['guestNames', 'isExternalGuest', 'allocationType', 'percentageDiscount', 'reason', 'selectedBusinessUnits', 'travelDocument', 'processTravelDocument', 'approvers', 'approverRoles', 'useParallelApprovals'],
    },

    // Travel Authorization Form Configuration
    travel_authorization: {
        type: 'travel_authorization',
        displayName: 'Travel Authorization',
        primaryField: 'purposeOfTravel',
        secondaryFields: ['dateOfIntendedTravel', 'travelMode'],
        sections: [
            { key: 'overview', title: 'Travel Overview', bgColor: 'blue-50', borderColor: 'blue-100' },
            { key: 'details', title: 'Travel Details', bgColor: 'gray-50', borderColor: 'gray-200' },
            { key: 'itinerary', title: 'Travel Itinerary', bgColor: 'gray-50', borderColor: 'gray-200' },
            { key: 'budget', title: 'Travel Budget', icon: 'currency', bgColor: 'primary-50', borderColor: 'primary-100' },
        ],
        fields: [
            { key: 'dateOfIntendedTravel', label: 'Date of Intended Travel', type: 'date', section: 'details' },
            { key: 'travelMode', label: 'Travel Mode', type: 'text', section: 'details' },
            { key: 'purposeOfTravel', label: 'Purpose of Travel', type: 'textarea', section: 'details', colSpan: 2 },
            { key: 'accompanyingAssociates', label: 'Accompanying Associates', type: 'textarea', section: 'details', colSpan: 2, hideIfEmpty: true },
            { key: 'itinerary', label: 'Travel Itinerary', type: 'table', section: 'itinerary', nestedFields: [
                { key: 'date', label: 'Date', type: 'date' },
                { key: 'from', label: 'From', type: 'text' },
                { key: 'to', label: 'To', type: 'text' },
                { key: 'km', label: 'KM', type: 'number' },
                { key: 'justification', label: 'Justification', type: 'text' },
            ]},
            { key: 'budget', label: 'Travel Budget', type: 'budget', section: 'budget', budgetItems: [
                { key: 'fuel', label: 'Fuel (Indicate Total litres)' },
                    { key: 'aaRates', label: 'AA Rates (Indicate Total Mileage)' },
                    { key: 'airBusTickets', label: 'Air/Bus Tickets' },
                    { key: 'b&b', label: 'Overnight Accommodation (b&b)' },
                    { key: 'lunchDinner', label: 'Lunch/Dinner' },
                    { key: 'conferencingCost', label: 'Conferencing Cost' },
                    { key: 'tollgates', label: 'Tollgates' },
                    { key: 'other', label: 'Other', descriptionKey: 'description' }
            ]},

            { key: 'grandTotal', label: 'Grand Total', type: 'currency', section: 'budget' },
        ],
        excludeFromGeneric: ['dateOfIntendedTravel', 'travelMode', 'purposeOfTravel', 'accompanyingAssociates', 'itinerary', 'budget', 'grandTotal', 'acceptConditions', 'approvers', 'approverRoles', 'useParallelApprovals', 'type'],
    },

    // CAPEX Form Configuration
    capex: {
        type: 'capex',
        displayName: 'Capital Expenditure',
        primaryField: 'projectName',
        secondaryFields: ['unit'],
        sections: [
            { key: 'project', title: 'Project Overview', bgColor: 'primary-50', borderColor: 'primary-100' },
            { key: 'financial', title: 'Financial Information', bgColor: 'gray-50', borderColor: 'gray-200' },
            { key: 'quotation', title: 'Quotations & Supplier Selection', bgColor: 'gray-50', borderColor: 'gray-200' },
            { key: 'justification', title: 'Justification', bgColor: 'gray-50', borderColor: 'gray-200' },
        ],
        fields: [
            { key: 'projectName', label: 'Project Name', type: 'text', section: 'project' },
            { key: 'requester', label: 'Requester', type: 'text', section: 'project' },
            { key: 'unit', label: 'Business Unit', type: 'text', section: 'project' },
            { key: 'department', label: 'Department', type: 'text', section: 'project' },
            { key: 'priority', label: 'Priority / Urgency', type: 'select', section: 'project', options: {
                low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical',
            }},
            { key: 'description', label: 'Detailed Description', type: 'textarea', section: 'project', colSpan: 2 },
            { key: 'amount', label: 'Project Cost', type: 'currency', section: 'financial', currencyKey: 'currency' },
            { key: 'currency', label: 'Currency', type: 'select', section: 'financial', options: { USD: 'USD', ZIG: 'ZIG' }},
            { key: 'budgetType', label: 'Budget Type', type: 'select', section: 'financial', options: {
                budget: 'Budgeted',
                'non-budget': 'Non-Budgeted',
                emergency: 'Emergency',
            }},
            { key: 'fundingSource', label: 'Funding Source', type: 'text', section: 'financial' },
            { key: 'paybackPeriod', label: 'Payback Period', type: 'select', section: 'financial', options: {
                '<6m': 'Less than 6 months', '6-12m': '6-12 months', '1-2y': '1-2 years', '2-3y': '2-3 years', '>3y': 'More than 3 years',
            }},
            { key: 'npv', label: 'NPV', type: 'currency', section: 'financial', currencyKey: 'currency' },
            { key: 'irr', label: 'IRR', type: 'text', section: 'financial' },
            { key: 'evaluation', label: 'Financial Evaluation', type: 'textarea', section: 'financial', colSpan: 2 },
            { key: 'quotationReason', label: 'Reason for fewer than 3 quotations', type: 'select', section: 'quotation', colSpan: 2, options: {
                existing_supplier: 'Existing supplier — continuity required',
                sole_supplier: 'Sole supplier — no alternatives available',
                specialized: 'Specialized service requiring specific expertise',
                other: 'Other reason — requires COO pre-approval first',
            }},
            { key: 'justification', label: 'Business Justification', type: 'textarea', section: 'justification', colSpan: 2 },
        ],
        excludeFromGeneric: ['projectName', 'requester', 'unit', 'department', 'priority', 'description', 'amount', 'currency', 'npv', 'irr', 'paybackPeriod', 'budgetType', 'fundingSource', 'evaluation', 'justification', 'quotationReason', 'quotations', 'supportingDocuments', 'approvers', 'approverRoles', 'useParallelApprovals', 'type'],
    },
};

// Get form config by type
export function getFormConfig(type: string): FormTypeConfig | null {
    return formConfigs[type] || null;
}

// Get all registered form types
export function getRegisteredFormTypes(): string[] {
    return Object.keys(formConfigs);
}

// Helper to format field values
export function formatFieldValue(value: any, field: FieldConfig): string {
    if (value === null || value === undefined || value === '') return 'N/A';

    switch (field.type) {
        case 'date':
            try {
                return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
            } catch {
                return value;
            }
        case 'boolean':
            return value ? 'Yes' : 'No';
        case 'select':
            return field.options?.[value] || value;
        case 'number':
            if (field.formatter === 'percentage') {
                return `${value}%`;
            }
            return typeof value === 'number' ? value.toLocaleString() : value;
        case 'currency':
            return typeof value === 'number' ? `$${value.toLocaleString()}` : `$${value}`;
        default:
            return String(value);
    }
}

// Helper to check if a field should be displayed
export function shouldDisplayField(value: any, field: FieldConfig): boolean {
    if (field.hideIfEmpty && (value === null || value === undefined || value === '')) {
        return false;
    }
    if (field.type === 'array' && (!Array.isArray(value) || value.length === 0)) {
        return false;
    }
    if (field.type === 'object' && (!value || typeof value !== 'object')) {
        return false;
    }
    return true;
}

// Calculate budget total
export function calculateBudgetTotal(budget: Record<string, any>, budgetItems: { key: string }[]): number {
    return budgetItems.reduce((sum, item) => {
        const itemData = budget[item.key];
        const totalCost = parseFloat(itemData?.totalCost) || 0;
        return sum + totalCost;
    }, 0);
}

// ============ TOLLGATE CONFIGURATION ============

export interface TollgateRoute {
    from: string;
    to: string;
    premium: number;
    standard: number;
    premiumCost: number;
    standardCost: number;
}

// Tollgate data for routes between RTG locations
export const TOLLGATE_ROUTES: TollgateRoute[] = [
    // From RTH
    { from: 'RTH', to: 'NAH', premium: 0, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'RTH', to: 'KHCC', premium: 1, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'RTH', to: 'BRH', premium: 5, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'RTH', to: 'AZAM', premium: 5, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'RTH', to: 'VFRH', premium: 5, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'RTH', to: 'MRC', premium: 2, standard: 0, premiumCost: 4, standardCost: 3 },
    // From NAH
    { from: 'NAH', to: 'RTH', premium: 0, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'NAH', to: 'KHCC', premium: 1, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'NAH', to: 'BRH', premium: 5, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'NAH', to: 'AZAM', premium: 5, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'NAH', to: 'VFRH', premium: 5, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'NAH', to: 'MRC', premium: 2, standard: 0, premiumCost: 4, standardCost: 3 },
    // From KHCC
    { from: 'KHCC', to: 'BRH', premium: 4, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'KHCC', to: 'AZAM', premium: 5, standard: 4, premiumCost: 4, standardCost: 3 },
    { from: 'KHCC', to: 'VFRH', premium: 4, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'KHCC', to: 'MRC', premium: 3, standard: 0, premiumCost: 4, standardCost: 3 },
    // From BRH
    { from: 'BRH', to: 'AZAM', premium: 0, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'BRH', to: 'VFRH', premium: 0, standard: 2, premiumCost: 4, standardCost: 3 },
    { from: 'BRH', to: 'MRC', premium: 7, standard: 0, premiumCost: 4, standardCost: 3 },
    // From AZAM
    { from: 'AZAM', to: 'VFRH', premium: 0, standard: 0, premiumCost: 4, standardCost: 3 },
    { from: 'AZAM', to: 'MRC', premium: 7, standard: 2, premiumCost: 4, standardCost: 3 },
    // From VFRH
    { from: 'VFRH', to: 'MRC', premium: 7, standard: 2, premiumCost: 4, standardCost: 3 },
];

export interface TollgateEntry {
    road: string;
    quantity: string;
    unitCost: string;
    totalCost: string;
}

export interface ItineraryRow {
    date: string;
    from: string;
    fromCustom?: string;
    to: string;
    toCustom?: string;
    km: string;
    justification: string;
}

export type TollgateRouteType = 'premium' | 'standard';

/**
 * Calculate tollgates based on itinerary routes
 * Returns array of tollgate entries with calculated costs
 */
export function calculateTollgatesForItinerary(
    itinerary: ItineraryRow[],
    routeType: TollgateRouteType = 'premium'
): TollgateEntry[] {
    const tollgates: TollgateEntry[] = [];

    for (const row of itinerary) {
        if (!row.from || !row.to || row.from === 'OTHER' || row.to === 'OTHER') {
            continue;
        }

        // Find matching route (try both directions)
        let route = TOLLGATE_ROUTES.find(r => r.from === row.from && r.to === row.to);
        if (!route) {
            route = TOLLGATE_ROUTES.find(r => r.from === row.to && r.to === row.from);
        }

        if (!route) {
            continue;
        }

        const tollCount = routeType === 'premium' ? route.premium : route.standard;
        const unitCost = routeType === 'premium' ? route.premiumCost : route.standardCost;
        const totalCost = tollCount * unitCost;

        if (tollCount > 0) {
            tollgates.push({
                road: `${row.from} → ${row.to} (${routeType})`,
                quantity: tollCount.toString(),
                unitCost: unitCost.toString(),
                totalCost: totalCost.toFixed(2),
            });
        }
    }

    return tollgates.length > 0 ? tollgates : [{ road: '', quantity: '1', unitCost: '', totalCost: '' }];
}

/**
 * Get tollgate summary for an itinerary route
 */
export function getTollgateRouteInfo(from: string, to: string): { premium: number; standard: number; premiumCost: number; standardCost: number } | null {
    if (!from || !to || from === 'OTHER' || to === 'OTHER') {
        return null;
    }

    let route = TOLLGATE_ROUTES.find(r => r.from === from && r.to === to);
    if (!route) {
        route = TOLLGATE_ROUTES.find(r => r.from === to && r.to === from);
    }

    if (!route) {
        return null;
    }

    return {
        premium: route.premium,
        standard: route.standard,
        premiumCost: route.premiumCost,
        standardCost: route.standardCost,
    };
}
