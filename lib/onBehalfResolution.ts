/**
 * Whose reporting line should a form resolve approvers from?
 *
 * A request filed on behalf of someone else belongs to THAT person, so the
 * approval chain is theirs — an HR admin filing travel for an employee routes
 * to the employee's own manager, not to HR's. (Before this, every form
 * resolved from the filer, so an assistant filing for their boss got the
 * assistant's chain.)
 *
 * External guests have no reporting line at all, so there is nothing to
 * resolve and the filer picks the approvers by hand — signalled by `null`.
 */
export interface OnBehalfTarget {
  userId?: string;
  email?: string;
  external?: boolean;
}

export function approverResolutionEmail(
  filerEmail: string | null | undefined,
  onBehalfOf: OnBehalfTarget | null | undefined
): string | null {
  // Outside the organization — no organogram to walk.
  if (onBehalfOf?.external) return null;
  // Filed for an employee: resolve from them. Fall back to the filer when the
  // beneficiary has no email on record, which is better than resolving nothing.
  if (onBehalfOf?.userId && onBehalfOf.email) return onBehalfOf.email;
  return filerEmail || null;
}
