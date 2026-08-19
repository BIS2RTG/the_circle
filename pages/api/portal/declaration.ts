import type { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireDirectorSession } from '@/lib/directorSession';
import { recordAccessEvent } from '@/lib/directorAudit';
import { getDeclarationDef } from '@/lib/bgmDeclarations';
import { applyDeclarationSubmission, isSignatureDataUrl } from '@/lib/bgmDeclarationsServer';

/**
 * GET  /api/portal/declaration?id=  — fetch one outstanding declaration to complete
 * POST /api/portal/declaration      — submit a completed, signed declaration
 *   body: { id, form_data, signature, signed_name, declaration_confirmed }
 * All scoped to the signed-in director. Audited as declaration_signed.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = await requireDirectorSession(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const id = String(req.query.id || '');
    const { data: decl } = await supabaseAdmin
      .from('governance_declarations')
      .select('id, declaration_type, status, period_year, due_date, form_data')
      .eq('id', id).eq('director_id', ctx.directorId).maybeSingle();
    if (!decl) return res.status(404).json({ error: 'Declaration not found.' });
    return res.status(200).json({
      type: decl.declaration_type, status: decl.status,
      declaration: { period_year: decl.period_year, due_date: decl.due_date, form_data: decl.form_data || {} },
    });
  }

  if (req.method === 'POST') {
    const { id, form_data, signature, signed_name, declaration_confirmed } = req.body || {};
    if (!declaration_confirmed) return res.status(400).json({ error: 'Please tick the declaration to confirm.' });
    if (!isSignatureDataUrl(signature)) return res.status(400).json({ error: 'Please sign to complete your declaration.' });

    const { data: decl } = await supabaseAdmin
      .from('governance_declarations').select('*').eq('id', id).eq('director_id', ctx.directorId).maybeSingle();
    if (!decl) return res.status(404).json({ error: 'Declaration not found.' });
    if (decl.status === 'submitted') return res.status(409).json({ error: 'This declaration is already submitted.' });
    if (decl.status === 'cancelled') return res.status(410).json({ error: 'This declaration has been withdrawn.' });
    if (!getDeclarationDef(decl.declaration_type)) return res.status(400).json({ error: 'Unknown declaration type.' });

    const result = await applyDeclarationSubmission({
      declaration: decl,
      formData: form_data && typeof form_data === 'object' ? form_data : {},
      signature,
      signedName: typeof signed_name === 'string' && signed_name.trim() ? signed_name.trim() : ctx.director.full_name,
      declarationConfirmed: true,
      via: 'self_link',
    });
    if (!result.ok) return res.status(500).json({ error: result.error });

    await recordAccessEvent({
      organizationId: ctx.organizationId, eventType: 'declaration_signed',
      directorId: ctx.directorId, sessionId: ctx.sessionId, action: 'sign_declaration',
      detail: 'portal', req, metadata: { declaration_id: id, type: decl.declaration_type },
    });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
