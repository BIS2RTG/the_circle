/**
 * Optional activities / add-ons that can be attached to a complimentary voucher.
 *
 * Shared by the request form (pages/requests/new/voucher.tsx), the voucher
 * document itself (pages/api/requests/[id]/voucher-pdf.ts) and the approver's
 * request preview, so the labels an approver signs off are exactly the ones
 * printed on the voucher.
 *
 * Stored on the request metadata as:
 *   voucherAddOns:      string[]  — the `value`s below, plus OTHER when used
 *   voucherAddOnOther:  string    — free text, only meaningful alongside OTHER
 *
 * Add-ons are always optional; an empty list simply prints no "plus" clause.
 */

export interface VoucherAddOn {
  value: string;
  label: string;
}

/** The fixed add-ons. "Other" is handled separately since it carries free text. */
export const VOUCHER_ADD_ONS: VoucherAddOn[] = [
  { value: 'game_drive', label: 'Game Drive' },
  { value: 'boat_cruise', label: 'Boat Cruise' },
  { value: 'airport_transfer', label: 'Airport Transfer' },
];

export const VOUCHER_ADD_ON_OTHER = 'other';

/**
 * The chosen add-ons as display labels, in the order they are listed above so
 * the voucher reads consistently no matter what order they were ticked in.
 * "Other" contributes the requester's own wording and is always listed last.
 */
export function resolveVoucherAddOnLabels(addOns?: unknown, otherText?: unknown): string[] {
  const chosen = Array.isArray(addOns) ? addOns.map(String) : [];
  if (chosen.length === 0) return [];

  const labels = VOUCHER_ADD_ONS.filter(a => chosen.includes(a.value)).map(a => a.label);

  if (chosen.includes(VOUCHER_ADD_ON_OTHER)) {
    const custom = typeof otherText === 'string' ? otherText.trim() : '';
    // A blank "Other" contributes nothing rather than an empty slot in the list.
    if (custom) labels.push(custom);
  }

  return labels;
}

/**
 * The add-ons as one natural-language phrase for the voucher's entitlement
 * sentence: "Game Drive", "Game Drive and Boat Cruise", "A, B and C".
 * Returns '' when there is nothing to add, so callers can append unconditionally.
 */
export function formatVoucherAddOnPhrase(addOns?: unknown, otherText?: unknown): string {
  const labels = resolveVoucherAddOnLabels(addOns, otherText);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
