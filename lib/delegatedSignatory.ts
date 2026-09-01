/**
 * "pp" (per procurationem) naming for delegated approvals.
 *
 * When an approval step is signed by somebody other than the approver the
 * workflow named — because an admin redirected it, or a delegation routed it —
 * the document must say so. The convention across The Circle is to prefix the
 * signatory with "pp":
 *
 *     pp Napoleon Mtukwa        (signing for the CEO)
 *     pp Chief Executive Officer
 *
 * This is the single source of that rule. Every request type — CAPEX, travel
 * authority, complimentary vouchers, inter-unit credit/debit notes, petty cash,
 * and the generic archive PDF — formats delegated signatories through here, so
 * a reader can never mistake a stand-in signature for the role holder's own.
 *
 * A step counts as delegated when `is_redirected` is set. `original_approver_id`
 * and `delegation_id` are recorded too, but redirects predating the delegation
 * feature only carry `is_redirected`, so that flag alone is the test.
 */

/** The shape every caller has to hand; extra fields are ignored. */
export interface DelegatableStep {
  is_redirected?: boolean | null;
  original_approver_id?: string | null;
  delegation_id?: string | null;
  redirect_job_title?: string | null;
}

export const PP_PREFIX = 'pp';

/** Was this step signed by a stand-in rather than its named approver? */
export function isDelegatedStep(step: DelegatableStep | null | undefined): boolean {
  return !!step?.is_redirected;
}

/**
 * Prefix a signatory's name with "pp" when the step was delegated.
 * Returns the name unchanged for a normal step, and null/'' untouched so
 * callers can keep their own fallbacks.
 */
export function ppName<T extends string | null | undefined>(
  name: T,
  step: DelegatableStep | null | undefined
): T {
  if (!name || !isDelegatedStep(step)) return name;
  const trimmed = String(name).trim();
  if (!trimmed) return name;
  // Never double-prefix a name that already carries it.
  if (new RegExp(`^${PP_PREFIX}\\s`, 'i').test(trimmed)) return name;
  return `${PP_PREFIX} ${trimmed}` as T;
}

/**
 * The role/job title to print under a delegated signature. A redirect may
 * record the title the stand-in signs under (`redirect_job_title`); otherwise
 * the role holder's own title stands, since the delegate signs *for* that role.
 */
export function ppJobTitle(
  jobTitle: string | null | undefined,
  step: DelegatableStep | null | undefined
): string | null {
  if (!isDelegatedStep(step)) return jobTitle || null;
  const title = step?.redirect_job_title || jobTitle;
  if (!title) return null;
  const trimmed = String(title).trim();
  if (new RegExp(`^${PP_PREFIX}\\s`, 'i').test(trimmed)) return trimmed;
  return `${PP_PREFIX} ${trimmed}`;
}
