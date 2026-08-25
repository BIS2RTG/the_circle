/**
 * Voucher fulfilment hook.
 *
 * Fired when a complimentary voucher request reaches fully-approved. It:
 *   1. Atomically issues the next gap-free sequential voucher number
 *      (001, 002, …) for the organization and stamps it onto the register row.
 *   2. Resolves the reception + reservations mailboxes for the selected
 *      hotel(s) — expanding "Any RTG Hotel of Choice" to every hotel — and
 *      emails the approved voucher to them.
 *
 * Entirely best-effort: any failure is logged and swallowed so it can never
 * affect the approval outcome. No-ops cleanly when Resend or the hotel contact
 * emails are unconfigured.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { sendEmail } from './email';
import { fetchHrimsBusinessUnits } from './hrimsClient';

interface VoucherRequest {
  creator_id: string;
  organization_id: string;
  title: string;
  metadata?: any;
}

function esc(v: any): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

export async function onVoucherFullyApproved(
  requestId: string,
  request: VoucherRequest
): Promise<void> {
  const metadata = request.metadata || {};
  const requestType = metadata.type || metadata.requestType;
  if (requestType !== 'voucher_request') return;

  const orgId = request.organization_id;

  try {
    // Idempotency: if this voucher already has a number, it's already been
    // fulfilled — don't issue a second number or re-send the email.
    const { data: existing } = await supabaseAdmin
      .from('vouchers')
      .select('id, seq')
      .eq('request_id', requestId)
      .maybeSingle();

    if (existing?.seq != null) return;

    const selectedUnits: Array<{ id: string; name: string; numberOfVouchers?: string }> = Array.isArray(metadata.selectedBusinessUnits)
      ? metadata.selectedBusinessUnits
      : [];

    // How many vouchers to issue — the "number of vouchers" set on a meal voucher
    // (max across units), at least 1. Capped to a sane maximum.
    const requestedCount = Math.max(
      1,
      ...selectedUnits.map((u) => {
        const n = parseInt(String(u.numberOfVouchers ?? ''), 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      })
    );
    const count = Math.min(requestedCount, 100);

    // 1. Issue `count` sequential numbers atomically (one RPC call each — the
    // counter is gap-free per org, so the numbers are consecutive).
    const seqs: number[] = [];
    for (let i = 0; i < count; i++) {
      const { data: seqValue, error: seqError } = await supabaseAdmin.rpc('issue_voucher_number', { p_org: orgId });
      if (seqError) {
        console.error('Failed to issue voucher number:', seqError);
        if (seqs.length === 0) return; // couldn't issue any — bail
        break;
      }
      const s = typeof seqValue === 'number' ? seqValue : Number(seqValue);
      if (!Number.isFinite(s)) {
        console.error('issue_voucher_number returned a non-numeric value:', seqValue);
        break;
      }
      seqs.push(s);
    }
    if (seqs.length === 0) return;

    const seq = seqs[0];
    const voucherNumbers = seqs.map((s) => String(s).padStart(3, '0'));
    const voucherNumber = voucherNumbers[0];

    // 2. Resolve the target hotels. "Any RTG Hotel of Choice" (id === 'any')
    // expands to every hotel so all of them are listed and emailed.
    const anySelected = selectedUnits.some((u) => u.id === 'any');
    let targetUnits: Array<{ id: string; name: string; code?: string }> = [];
    if (anySelected) {
      try {
        const all = await fetchHrimsBusinessUnits();
        targetUnits = all
          .filter((u) => u.name?.toLowerCase() !== 'head office')
          .map((u) => ({ id: String(u.id), name: u.name, code: u.code }));
      } catch (hrimsErr) {
        console.error('Failed to expand "Any RTG Hotel" for voucher email:', hrimsErr);
        targetUnits = [];
      }
    } else {
      targetUnits = selectedUnits.filter((u) => u.id && u.id !== 'any');
    }

    // Look up reception/reservations mailboxes for those hotels.
    const targetIds = targetUnits.map((u) => u.id);
    const recipients = new Set<string>();
    if (targetIds.length > 0) {
      const { data: contacts } = await supabaseAdmin
        .from('business_unit_contacts')
        .select('business_unit_id, reception_email, reservations_email')
        .eq('organization_id', orgId)
        .in('business_unit_id', targetIds);

      for (const c of contacts || []) {
        if (c.reception_email) recipients.add(c.reception_email.trim());
        if (c.reservations_email) recipients.add(c.reservations_email.trim());
      }
    }

    const recipientList = Array.from(recipients).filter(Boolean);

    // 3. Send the voucher email to each mailbox (best-effort).
    const numbersLabel = voucherNumbers.length === 1
      ? voucherNumber
      : `${voucherNumbers[0]}–${voucherNumbers[voucherNumbers.length - 1]} (${voucherNumbers.length} vouchers)`;

    let emailSent = false;
    if (recipientList.length > 0) {
      const hotelListHtml = targetUnits.map((u) => `<li>${esc(u.name)}</li>`).join('');
      const subject = `Complimentary Voucher ${numbersLabel} — ${request.title || 'Voucher Request'}`;
      const html = `
        <div style="font-family: 'Segoe UI', Tahoma, sans-serif; color:#374151;">
          <h2 style="margin:0 0 16px;">Complimentary Voucher${voucherNumbers.length > 1 ? 's' : ''} ${esc(numbersLabel)}</h2>
          <p>${voucherNumbers.length > 1 ? `${voucherNumbers.length} complimentary accommodation vouchers have` : 'A complimentary accommodation voucher has'} been fully approved${
            anySelected ? ' and is redeemable at any RTG hotel below' : ''
          }.</p>
          <table style="border-collapse:collapse; margin:12px 0;">
            <tr><td style="padding:4px 12px 4px 0; font-weight:600;">Voucher Number${voucherNumbers.length > 1 ? 's' : ''}</td><td>${esc(voucherNumbers.join(', '))}</td></tr>
            <tr><td style="padding:4px 12px 4px 0; font-weight:600;">Guest(s)</td><td>${esc(metadata.guestNames || '—')}</td></tr>
            <tr><td style="padding:4px 12px 4px 0; font-weight:600;">Reason</td><td>${esc(metadata.reason || '—')}</td></tr>
          </table>
          <p style="font-weight:600; margin:16px 0 4px;">${anySelected ? 'Valid at any of the following hotels:' : 'Hotel(s):'}</p>
          <ul>${hotelListHtml}</ul>
          <p style="margin-top:16px; color:#6b7280; font-size:13px;">Rainbow Tourism Group • The Circle Approval System</p>
        </div>`;

      const results = await Promise.all(
        recipientList.map((to) => sendEmail({ to, subject, html }))
      );
      emailSent = results.some((r) => r.success);
    } else {
      console.warn(
        `Voucher ${voucherNumber}: no reception/reservations emails configured for the selected hotel(s); email not sent.`
      );
    }

    // 4. Persist the register row (upsert covers the case where the pending
    // row wasn't created at submission).
    await supabaseAdmin
      .from('vouchers')
      .upsert(
        {
          organization_id: orgId,
          request_id: requestId,
          seq,
          voucher_number: voucherNumber,
          voucher_numbers: voucherNumbers,
          guest_names: metadata.guestNames || null,
          business_units: selectedUnits,
          reason: metadata.reason || null,
          email_sent: emailSent,
          email_sent_at: emailSent ? new Date().toISOString() : null,
          email_recipients: recipientList,
          created_by: request.creator_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'request_id' }
      );

    // 5. Stamp the number(s) onto the request metadata so the UI + voucher
    // document show the real sequential number (not the VCH-<id> fallback).
    await supabaseAdmin
      .from('requests')
      .update({ metadata: { ...metadata, voucherNumber, voucherNumbers } })
      .eq('id', requestId);
  } catch (err) {
    console.error('onVoucherFullyApproved failed:', err);
  }
}
