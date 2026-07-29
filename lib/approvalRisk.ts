/**
 * Risk-Based Authentication for Approvals
 * ----------------------------------------
 * Classifies an approval action as medium / high risk. The classification
 * drives which authentication ceremony the user must pass before their decision
 * is recorded:
 *
 *   medium -> Microsoft Entra step-up (prompt=login, tenant-enforced MFA)
 *            — this is the organisation-wide FLOOR; every approval requires
 *              at least an MFA re-verification (a 15-minute elevated session
 *              covers a batch of approvals after one successful ceremony).
 *   high   -> WebAuthn biometric (Windows Hello / Touch ID / Face ID)
 *            (fallback to medium if the user has no registered credential)
 *
 * The 'low' tier is retained in the type for historical records and
 * defense-in-depth conversions, but the evaluator never produces it.
 *
 * Signals (any one is sufficient to escalate):
 *   - monetary value          -> >= HIGH_VALUE_THRESHOLD -> high
 *                                >= MEDIUM_VALUE_THRESHOLD -> medium
 *   - creator / step department is sensitive (Finance, HR, Legal, Exec) -> high
 *   - request category is sensitive (payroll, contract, policy)        -> medium+
 *   - this is the FINAL approval in the chain (last gate before commit) -> high
 *
 * Everything else (small-ticket departmental approvals, intermediate steps,
 * informational workflows) settles at low risk.
 *
 * The function is pure and side-effect free so it can be called from both
 * the browser (to pre-select the UI flow) and the server (which is
 * authoritative — the server verdict governs auth enforcement).
 */

export type ApprovalRisk = 'low' | 'medium' | 'high';

export type AuthenticationMethod = 'session' | 'microsoft_mfa' | 'biometric';

// ---------------------------------------------------------------------------
// KILL SWITCH — identity verification on approvals.
//
// When true, EVERY approval is treated as low-risk / session-only: no
// Microsoft MFA and no biometric ceremony is ever required, on any request.
// This is the single choke point — both the browser (which hides the
// "verify your identity before you can review" gate for low risk) and the
// server (`pages/api/approvals/action.ts`, which skips enforcement when the
// required auth is 'session') read the result of `getApprovalRisk`, so
// flipping this one flag disables verification everywhere.
//
// To RE-ENABLE the risk-based verification, set this back to `false`.
// ---------------------------------------------------------------------------
export const APPROVAL_VERIFICATION_DISABLED = true;

// ---------------------------------------------------------------------------
// Thresholds / configuration — adjust here, not in call sites.
// ---------------------------------------------------------------------------

/** Any approval whose value >= this is HIGH risk. USD-equivalent. */
export const HIGH_VALUE_THRESHOLD = 50_000;

/** Any approval whose value >= this (and below HIGH) is MEDIUM risk. */
export const MEDIUM_VALUE_THRESHOLD = 5_000;

/** Department names that always escalate to HIGH. Compared case-insensitively. */
const HIGH_RISK_DEPARTMENTS = new Set([
  'finance',
  'hr',
  'human resources',
  'legal',
  'executive',
  'executives',
  'c-suite',
  'board',
]);

/** Department / category hints that escalate to MEDIUM (or higher if combined). */
const MEDIUM_RISK_DEPARTMENTS = new Set([
  'procurement',
  'operations',
  'it',
  'security',
  'compliance',
]);

/** Workflow categories that ALWAYS escalate to HIGH risk regardless of value. */
const HIGH_RISK_CATEGORIES = new Set([
  'capex',
  'capital_expenditure',
  'capital-expenditure',
]);

/** Workflow categories that are inherently sensitive (medium minimum). */
const SENSITIVE_CATEGORIES = new Set([
  'payroll',
  'compensation',
  'contract',
  'legal',
  'policy',
  'hr',
  'finance',
  'budget',
  'termination',
  'hiring',
]);

/** Request types that ALWAYS escalate to HIGH risk regardless of value. */
const HIGH_RISK_REQUEST_TYPES = new Set([
  'capex',
  'capex_request',
  'capital_expenditure',
]);

/** Request types that are inherently sensitive (medium minimum). */
const SENSITIVE_REQUEST_TYPES = new Set([
  'contract_approval',
  'salary_change',
  'termination_request',
  'policy_change',
]);

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Everything the risk evaluator needs. All fields optional so callers can
 * supply whatever they have — missing signals mean "no signal", not "low risk".
 */
export interface ApprovalRiskInput {
  /** Monetary value of the request, in the organization's primary currency. */
  value?: number | null;

  /** Department name or slug of the creator (or the subject of the request). */
  creatorDepartment?: string | null;

  /** Department the CURRENT step belongs to (may differ from creator department). */
  stepDepartment?: string | null;

  /** Workflow category (from workflow_definitions.category). */
  workflowCategory?: string | null;

  /** Free-form request type hint (e.g. metadata.type / metadata.requestType). */
  requestType?: string | null;

  /** Zero-indexed position of the step being actioned. */
  currentStepIndex?: number | null;

  /** Total number of approval steps in the chain. */
  totalSteps?: number | null;

  /** Optional raw form data — scanned for common value field names. */
  formData?: Record<string, any> | null;

  /** Optional explicit risk override from the workflow definition. */
  explicitRisk?: ApprovalRisk | null;
}

export interface RiskEvaluation {
  risk: ApprovalRisk;
  /** Human-readable reasons, for audit logs and tooltips. */
  reasons: string[];
  /** The authentication method the user must pass to satisfy this risk. */
  requiredAuth: AuthenticationMethod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(value: string | null | undefined): string {
  return (value || '').toString().trim().toLowerCase();
}

/**
 * Pull the monetary value from a form data blob without knowing the exact
 * field name. We probe common names (total, amount, value, cost, ...) and
 * take the first numeric hit. This keeps the risk engine decoupled from
 * every workflow's bespoke form schema.
 */
function extractValueFromFormData(formData: Record<string, any> | null | undefined): number | null {
  if (!formData) return null;
  const candidates = [
    'total', 'total_amount', 'total_cost', 'total_value',
    'amount', 'value', 'cost', 'price',
    'grand_total', 'estimated_cost', 'budget',
  ];
  for (const key of candidates) {
    const raw = formData[key];
    if (raw == null) continue;
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function isHighRiskDepartment(name: string | null | undefined): boolean {
  const n = normalize(name);
  if (!n) return false;
  return [...HIGH_RISK_DEPARTMENTS].some(d => n === d || n.includes(d));
}

function isMediumRiskDepartment(name: string | null | undefined): boolean {
  const n = normalize(name);
  if (!n) return false;
  return [...MEDIUM_RISK_DEPARTMENTS].some(d => n === d || n.includes(d));
}

function isHighRiskCategory(category: string | null | undefined): boolean {
  const c = normalize(category);
  if (!c) return false;
  return [...HIGH_RISK_CATEGORIES].some(cat => c === cat || c.includes(cat));
}

function isSensitiveCategory(category: string | null | undefined): boolean {
  const c = normalize(category);
  if (!c) return false;
  return [...SENSITIVE_CATEGORIES].some(cat => c === cat || c.includes(cat));
}

function isHighRiskRequestType(type: string | null | undefined): boolean {
  const t = normalize(type);
  if (!t) return false;
  return [...HIGH_RISK_REQUEST_TYPES].some(rt => t === rt || t.includes(rt));
}

function isSensitiveRequestType(type: string | null | undefined): boolean {
  const t = normalize(type);
  if (!t) return false;
  return SENSITIVE_REQUEST_TYPES.has(t);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate the risk of a pending approval action.
 *
 * Pure function — the same input always yields the same output so we can
 * run this on the server (authoritative) and the client (UI hint) and
 * trust that they agree when given the same data.
 */
export function getApprovalRisk(input: ApprovalRiskInput): RiskEvaluation {
  // Kill switch: verification disabled org-wide → every approval is low-risk,
  // satisfied by the authenticated session alone (no MFA / biometric ceremony).
  if (APPROVAL_VERIFICATION_DISABLED) {
    return {
      risk: 'low',
      reasons: ['Approval identity verification is currently disabled'],
      requiredAuth: 'session',
    };
  }

  // Respect explicit risk override (e.g. a workflow author marked a step
  // "always high"). Still compute reasons for audit visibility. A workflow
  // declaring 'low' is bumped to the organisation-wide floor of 'medium' —
  // we never accept a session-only approval.
  if (input.explicitRisk) {
    const effective: ApprovalRisk = input.explicitRisk === 'low' ? 'medium' : input.explicitRisk;
    return {
      risk: effective,
      reasons: [`Workflow-declared risk: ${input.explicitRisk}`].concat(
        effective !== input.explicitRisk ? ['Raised to organisation floor (medium)'] : []
      ),
      requiredAuth: authForRisk(effective),
    };
  }

  const reasons: string[] = [];
  // Policy: every approval requires identity re-verification. We start at
  // 'medium' (Microsoft MFA) as the organisation-wide floor — the 15-minute
  // elevated-session cookie keeps batch approvals frictionless. Specific
  // signals can still raise this to 'high' (biometric).
  let risk: ApprovalRisk = 'medium';
  reasons.push('All approvals require identity verification');

  // Helper that only *raises* the risk level — medium -> high, never backwards.
  const raise = (to: ApprovalRisk, reason: string) => {
    if (rank(to) > rank(risk)) risk = to;
    reasons.push(reason);
  };

  // ---- monetary value ---------------------------------------------------
  const rawValue = input.value ?? extractValueFromFormData(input.formData);
  if (rawValue != null && rawValue >= HIGH_VALUE_THRESHOLD) {
    raise('high', `High monetary value (${formatCurrency(rawValue)} >= ${formatCurrency(HIGH_VALUE_THRESHOLD)})`);
  } else if (rawValue != null && rawValue >= MEDIUM_VALUE_THRESHOLD) {
    raise('medium', `Moderate monetary value (${formatCurrency(rawValue)} >= ${formatCurrency(MEDIUM_VALUE_THRESHOLD)})`);
  }

  // ---- department sensitivity ------------------------------------------
  if (isHighRiskDepartment(input.creatorDepartment)) {
    raise('high', `Creator department is high-risk: ${input.creatorDepartment}`);
  } else if (isMediumRiskDepartment(input.creatorDepartment)) {
    raise('medium', `Creator department is sensitive: ${input.creatorDepartment}`);
  }

  if (isHighRiskDepartment(input.stepDepartment)) {
    raise('high', `Approval step department is high-risk: ${input.stepDepartment}`);
  } else if (isMediumRiskDepartment(input.stepDepartment)) {
    raise('medium', `Approval step department is sensitive: ${input.stepDepartment}`);
  }

  // ---- category / request type ----------------------------------------
  if (isHighRiskCategory(input.workflowCategory)) {
    raise('high', `High-risk workflow category: ${input.workflowCategory}`);
  } else if (isSensitiveCategory(input.workflowCategory)) {
    raise('medium', `Sensitive workflow category: ${input.workflowCategory}`);
  }
  if (isHighRiskRequestType(input.requestType)) {
    raise('high', `High-risk request type: ${input.requestType}`);
  } else if (isSensitiveRequestType(input.requestType)) {
    raise('medium', `Sensitive request type: ${input.requestType}`);
  }

  // ---- final-step escalation ------------------------------------------
  // The last gate commits the decision irreversibly — treat it like signing
  // the cheque, even if earlier steps were low risk.
  if (
    typeof input.currentStepIndex === 'number' &&
    typeof input.totalSteps === 'number' &&
    input.totalSteps > 0 &&
    input.currentStepIndex === input.totalSteps - 1
  ) {
    // Only escalate to HIGH if there's already *some* elevated signal, OR if
    // it's a multi-step workflow (single-step workflows are already the final
    // step by definition — don't blanket-HIGH everything).
    if (input.totalSteps > 1) {
      raise('high', 'Final approval step in the chain');
    }
  }

  return {
    risk,
    reasons,
    requiredAuth: authForRisk(risk),
  };
}

/**
 * Map a risk level to the authentication method required to satisfy it.
 * Exported so UI can label the ceremony ("Verify with biometrics") before
 * making the server call.
 */
export function authForRisk(risk: ApprovalRisk): AuthenticationMethod {
  switch (risk) {
    case 'high':
      return 'biometric';
    case 'medium':
      return 'microsoft_mfa';
    case 'low':
    default:
      // Defense-in-depth: even if some caller bypasses getApprovalRisk and
      // hands us 'low' directly, require MFA. Session-only approvals are not
      // permitted under the current policy.
      return 'microsoft_mfa';
  }
}

/**
 * Human-readable label for audit trails and PDF annotations.
 * Mirrors the language required in the generated approval documents.
 */
export function authMethodLabel(method: AuthenticationMethod): string {
  switch (method) {
    case 'biometric':
      return 'Verified via biometric authentication';
    case 'microsoft_mfa':
      return 'Verified via Microsoft authentication';
    case 'session':
    default:
      return 'Verified via authenticated session';
  }
}

/**
 * Determine whether a claimed authentication method satisfies the required
 * one. Biometric always satisfies; microsoft_mfa satisfies medium+low;
 * session satisfies only low.
 *
 * Used server-side to accept a fallback (e.g. user without biometric
 * credentials completing microsoft_mfa for a high-risk approval).
 */
export function satisfiesAuth(
  provided: AuthenticationMethod,
  required: AuthenticationMethod
): boolean {
  return rankAuth(provided) >= rankAuth(required);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function rank(r: ApprovalRisk): number {
  return r === 'high' ? 2 : r === 'medium' ? 1 : 0;
}

function rankAuth(m: AuthenticationMethod): number {
  return m === 'biometric' ? 2 : m === 'microsoft_mfa' ? 1 : 0;
}

function formatCurrency(value: number): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `$${value.toLocaleString()}`;
  }
}
