/**
 * Which auto-resolved approver rows the requester may still change.
 *
 * Every approver is auto-resolved from the HRIMS organogram, but not all should
 * be locked. Departmental / managerial roles (resolved by walking the org chart
 * or by department) may legitimately need swapping, so they stay editable even
 * when auto-filled. The senior, fixed roles (CEO, HRD, the directors, etc.) are
 * locked — the org chart's authority must not be overridden for those.
 *
 * Keys match the role keys used across the request forms and
 * pages/api/hrims/resolve-approvers.ts.
 */
export const CHANGEABLE_AUTO_APPROVER_ROLES = new Set<string>([
  'line_manager',
  'functional_head',
  'finance_manager',
  'accountant',
  'general_manager',
  'corporate_hod',
  'department_head',
  // Voucher first approver — a generic "Approver" the requester picks/swaps
  // freely (its title on the voucher comes from the selected user's job title).
  'commercial_director',
  // Inter-unit equivalents (a from-unit finance manager / receiving-unit accountant).
  'from_finance_manager',
  'to_accountant',
]);

/**
 * True when an approver row must be locked (no remove/change control): it was
 * auto-resolved AND its role is not in the changeable set. Manually-selected or
 * empty rows are never locked.
 */
export function isApproverRowLocked(roleKey: string, isAutoResolved: boolean): boolean {
  return !!isAutoResolved && !CHANGEABLE_AUTO_APPROVER_ROLES.has(roleKey);
}
