/**
 * The standard CAPEX approval workflow.
 *
 * Every CAPEX form uses this fixed chain of approver roles, grouped into the two
 * signature blocks that appear on the official CAPEX form:
 *   - "Project Requested By" — the originating/operational sign-offs
 *   - "Project Approved By"  — the final executive authorisation
 *
 * This is the single source of truth shared by the CAPEX form picker
 * (pages/requests/new/capex.tsx), the on-screen preview, and the printable PDF
 * (pages/api/requests/[id]/pdf.ts) so the role list and ordering never drift.
 *
 * NOTE: approvers are OPTIONAL on CAPEX — a requester may leave a role blank. A
 * blank role is still printed on the form/PDF with an empty signature line so it
 * is visible that the position was intentionally left unfilled.
 */

export interface CapexApprovalRole {
  key: string;
  label: string;
  description: string;
}

export interface CapexApprovalSection {
  title: string;
  roles: CapexApprovalRole[];
}

export const CAPEX_APPROVAL_SECTIONS: CapexApprovalSection[] = [
  {
    title: 'Project Requested By',
    roles: [
      { key: 'finance_manager', label: 'Finance Manager / Accountant', description: 'Financial Review' },
      { key: 'general_manager', label: 'General Manager (Unit)', description: 'Unit Approval' },
      { key: 'procurement_manager', label: 'Procurement and Projects Manager', description: 'Procurement & Projects Review' },
      { key: 'corporate_hod', label: 'Corporate Head of Dept', description: 'Department Approval' },
      { key: 'managing_director', label: 'Chief Operating Officer', description: 'Operations Approval' },
    ],
  },
  {
    title: 'Project Approved By',
    roles: [
      { key: 'finance_director', label: 'Chief Finance Officer', description: 'Final Financial Approval' },
      { key: 'ceo', label: 'Group Chief Executive', description: 'Final Authorization' },
    ],
  },
];

/** Flat, ordered list of every CAPEX approver role (Requested By, then Approved By). */
export const CAPEX_APPROVAL_ROLES: CapexApprovalRole[] =
  CAPEX_APPROVAL_SECTIONS.flatMap((section) => section.roles);
