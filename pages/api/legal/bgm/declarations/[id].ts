import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireBgm } from '@/lib/bgmApi';
import { getDeclarationDef } from '@/lib/bgmDeclarations';
import { applyDeclarationSubmission, isSignatureDataUrl } from '@/lib/bgmDeclarationsServer';

/**
 * GET    /api/legal/bgm/declarations/[id]  — full declaration + director + issuer
 * PATCH  /api/legal/bgm/declarations/[id]  — actions:
 *          { action: 'complete', form_data, signature, signed_name, declaration_confirmed }
 *              → record the signed declaration on behalf of the director (in person)
 *          { action: 'cancel' } → cancel an outstanding declaration
 * DELETE /api/legal/bgm/declarations/[id]  — delete a draft/cancelled declaration
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id);

  if (req.method === 'GET') {
    const ctx = await requireBgm(req, res, ['bgm.declarations.view']);
    if (!ctx) return;

    const { data, error } = await supabaseAdmin
      .from('governance_declarations')
      .select('*, director:directors(id, full_name, salutation, email, phone, status), meeting:board_meetings(id, title, scheduled_start)')
      .eq('id', id).eq('organization_id', ctx.organizationId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Declaration not found.' });

    let issuer: any = null;
    if (data.issued_by) {
      const { data: u } = await supabaseAdmin.from('app_users').select('display_name, email').eq('id', data.issued_by).maybeSingle();
      issuer = u || null;
    }
    return res.status(200).json({ declaration: data, issuer });
  }

  if (req.method === 'PATCH') {
    const ctx = await requireBgm(req, res, ['bgm.declarations.manage']);
    if (!ctx) return;

    const { data: decl } = await supabaseAdmin
      .from('governance_declarations')
      .select('*')
      .eq('id', id).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!decl) return res.status(404).json({ error: 'Declaration not found.' });

    const action = req.body?.action;

    if (action === 'cancel') {
      if (decl.status === 'submitted') return res.status(409).json({ error: 'A submitted declaration cannot be cancelled.' });
      const { error } = await supabaseAdmin
        .from('governance_declarations')
        .update({ status: 'cancelled', access_token: null })
        .eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'complete') {
      if (decl.status === 'submitted') return res.status(409).json({ error: 'This declaration is already submitted.' });
      const def = getDeclarationDef(decl.declaration_type);
      if (!def) return res.status(400).json({ error: 'Unknown declaration type.' });

      const { form_data, signature, signed_name, declaration_confirmed } = req.body || {};
      if (!declaration_confirmed) return res.status(400).json({ error: 'The declaration must be confirmed.' });
      if (!isSignatureDataUrl(signature)) return res.status(400).json({ error: 'A signature is required.' });

      const result = await applyDeclarationSubmission({
        declaration: decl,
        formData: form_data && typeof form_data === 'object' ? form_data : {},
        signature,
        signedName: typeof signed_name === 'string' && signed_name.trim() ? signed_name.trim() : null,
        declarationConfirmed: true,
        via: 'in_person',
      });
      if (!result.ok) return res.status(500).json({ error: result.error });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  }

  if (req.method === 'DELETE') {
    const ctx = await requireBgm(req, res, ['bgm.declarations.manage']);
    if (!ctx) return;
    const { data: decl } = await supabaseAdmin
      .from('governance_declarations').select('status').eq('id', id).eq('organization_id', ctx.organizationId).maybeSingle();
    if (!decl) return res.status(404).json({ error: 'Declaration not found.' });
    if (decl.status === 'submitted') return res.status(409).json({ error: 'A submitted declaration cannot be deleted — it forms part of the governance record.' });
    const { error } = await supabaseAdmin.from('governance_declarations').delete().eq('id', id).eq('organization_id', ctx.organizationId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
