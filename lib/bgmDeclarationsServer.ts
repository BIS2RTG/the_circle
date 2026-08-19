/**
 * Server-only helpers for BGM-03 governance declarations.
 * Keeps the shared submission side-effects (finalise the record, auto-populate
 * the Director profile, notify the issuer) in one place so the public signing
 * route and the staff "complete on behalf" route behave identically.
 */
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getDeclarationDef, directorProfilePatchFromInfo } from '@/lib/bgmDeclarations';

/** Data URL guard for captured signatures. */
export function isSignatureDataUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:image') && v.length < 2_000_000;
}

interface SubmitArgs {
  declaration: any;                 // the governance_declarations row (pre-submit)
  formData: Record<string, any>;
  signature: string;
  signedName: string | null;
  declarationConfirmed: boolean;
  via: 'self_link' | 'in_person' | 'staff_entry';
}

/**
 * Finalise a declaration: write the signed record, project a director_information
 * submission onto the directors row, and notify the issuer in-app. Best-effort
 * on the side effects — a notification failure never fails the submission.
 */
export async function applyDeclarationSubmission({
  declaration, formData, signature, signedName, declarationConfirmed, via,
}: SubmitArgs): Promise<{ ok: boolean; error?: string }> {
  const nowIso = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('governance_declarations')
    .update({
      status: 'submitted',
      form_data: formData,
      declaration_confirmed: !!declarationConfirmed,
      signature,
      signed_name: signedName,
      signed_at: nowIso,
      submitted_at: nowIso,
      submitted_via: via,
      // one-time token is spent on submission
      access_token: null,
    })
    .eq('id', declaration.id);

  if (error) return { ok: false, error: 'Could not save your declaration.' };

  // Auto-populate the Director profile from a Director Information submission.
  if (declaration.declaration_type === 'director_information') {
    const patch = directorProfilePatchFromInfo(formData);
    if (Object.keys(patch).length > 0) {
      await supabaseAdmin.from('directors').update(patch).eq('id', declaration.director_id).then(() => {}, () => {});
    }
    await supabaseAdmin.from('governance_declarations')
      .update({ applied_to_profile: true }).eq('id', declaration.id).then(() => {}, () => {});
  }

  // Notify the issuer (in-app) that the declaration is in.
  const notifyUser = declaration.issued_by || declaration.created_by;
  if (notifyUser) {
    const def = getDeclarationDef(declaration.declaration_type);
    const { data: dir } = await supabaseAdmin
      .from('directors').select('full_name').eq('id', declaration.director_id).maybeSingle();
    await supabaseAdmin.from('notifications').insert({
      recipient_id: notifyUser,
      type: 'task',
      title: 'Governance declaration submitted',
      message: `${dir?.full_name || 'A director'} submitted their ${def?.shortLabel || 'declaration'}.`,
      metadata: { action_label: 'View declaration', action_url: `/legal/board/declarations/${declaration.id}` },
      is_read: false,
    }).then(() => {}, () => {});
  }

  return { ok: true };
}
