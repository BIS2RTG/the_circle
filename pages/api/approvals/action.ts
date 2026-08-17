import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ApprovalEngine } from '@/lib/approvalEngine';
import { audit } from '@/lib/auditLog';
import { runInBackground } from '@/lib/backgroundTask';
import {
  SIGNATURE_BUCKET,
  signatureExists,
  userSignaturePath,
  userSignatureProxyUrl,
  pathSignatureProxyUrl,
} from '@/lib/signatureStorage';
import { validateBody, z } from '@/lib/validate';

const ActionSchema = z.object({
  requestId: z.string().uuid(),
  stepId: z.string().uuid(),
  action: z.string().min(1).max(40),
  comment: z.string().max(5000).optional().nullable(),
  signatureType: z.enum(['saved', 'manual', 'typed']).optional(),
  signatureData: z.string().max(2_000_000).optional().nullable(),
  authMethod: z.string().max(40).optional().nullable(),
  deviceInfo: z.record(z.any()).optional().nullable(),
  costAllocation: z.record(z.any()).optional().nullable(),
  allocationType: z.string().max(60).optional().nullable(),
}).strip();

/**
 * POST /api/approvals/action
 *
 * Records an approval decision. Identity re-verification (Microsoft MFA
 * step-up / WebAuthn biometric) is NOT part of this flow — an authenticated
 * session is sufficient to record an approve/reject. The approver confirms
 * the decision in a lightweight dialog client-side; the server just records
 * it with audit context (signature source, IP, device) and hands off to the
 * approval engine.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = session.user.id as string;

    const parsedBody = validateBody(req, res, ActionSchema);
    if (!parsedBody) return;
    const {
      requestId,
      stepId,
      action,
      comment,
      signatureType,         // 'saved' | 'manual'  (typed is no longer accepted)
      signatureData,         // for 'manual': data URL of the freshly drawn signature
      deviceInfo,            // { userAgent, platform, screen } — opaque JSONB
      costAllocation,        // HR Director travel_authorization cost allocation
      allocationType,        // HR Director comp-booking category (hotel bookings only)
    } = parsedBody;

    // Typed signatures are disallowed organisation-wide. Reject them at the
    // boundary so old clients that still send `typed` get a clear error
    // rather than silently being downgraded.
    if (signatureType === 'typed') {
      return res.status(400).json({
        error: 'Typed signatures are no longer accepted. Please use your saved signature or draw one.',
        code: 'TYPED_SIGNATURE_DISALLOWED',
      });
    }

    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }

    // -----------------------------------------------------------------
    // Resolve the signature to apply.
    // -----------------------------------------------------------------
    let signatureUrl: string | null = null;
    let signatureReference: string | null = null;
    let resolvedSignatureType: 'saved' | 'manual' | undefined = signatureType;

    if (action === 'approve') {
      if (signatureType === 'manual' && typeof signatureData === 'string' && signatureData.startsWith('data:image')) {
        // Freshly drawn at approval time. Upload to storage so the PDF
        // generator can reference it like any saved signature.
        const uploaded = await uploadManualSignature(userId, requestId, stepId, signatureData);
        if (uploaded) {
          signatureUrl = uploaded;
          signatureReference = uploaded;
        } else {
          // Upload failed (transient storage error). Persist the drawn image
          // INLINE as a data URL rather than leaving it null — otherwise the
          // preview/PDF fall back to the approver's SAVED signature, showing a
          // signature they didn't actually sign with. The document preview
          // renders data: URLs directly and the PDF generator passes them
          // through, so the approver's real mark is always what's shown.
          signatureUrl = signatureData;
          signatureReference = signatureData;
        }
        resolvedSignatureType = 'manual';
      } else {
        // Default: use the user's saved signature from the private bucket.
        // Existence is checked via the service role; the persisted reference is
        // the authenticated proxy URL (no public URLs).
        if (await signatureExists(userSignaturePath(userId))) {
          signatureUrl = userSignatureProxyUrl(userId);
          signatureReference = signatureUrl;
          resolvedSignatureType = resolvedSignatureType || 'saved';
        }
      }
    }

    // -----------------------------------------------------------------
    // HR Director cost allocation (travel_authorization): server-side
    // enforcement + persist the authoritative allocation into metadata.
    // -----------------------------------------------------------------
    if (action === 'approve' && costAllocation && typeof costAllocation === 'object') {
      const { data: reqRow } = await supabaseAdmin
        .from('requests')
        .select('metadata')
        .eq('id', requestId)
        .single();

      const meta = (reqRow?.metadata as any) || {};
      // HR Director cost allocation is required for:
      //   - travel authorisations (local + international)
      //   - all hotel bookings (the HRD always signs off on which units
      //     carry the cost / comp value, even when no travel doc is bundled)
      const requiresAllocation =
        meta.type === 'travel_authorization' ||
        meta.type === 'international_travel_authorization' ||
        meta.type === 'hotel_booking' ||
        meta.type === 'external_hotel_booking';
      const hrdUserId = meta.approverRoles?.hrd;

      if (requiresAllocation && hrdUserId && hrdUserId === userId) {
        const units = ['corp', 'mrc', 'nah', 'rth', 'khcc', 'brh', 'vfrh', 'azam'];
        const cleaned: Record<string, string> = {};
        let sum = 0;
        for (const u of units) {
          const raw = (costAllocation as any)[u];
          const num = parseFloat(raw ?? '0') || 0;
          cleaned[u] = num > 0 ? num.toFixed(2) : '';
          sum += num;
        }
        const grandTotal = parseFloat(meta.grandTotal || '0') || 0;
        // When a grand total is present, allocations must sum to it.
        // For pure comp bookings (no grand total), accept any non-zero
        // allocation — the HRD's signed-off split is what we record.
        if (grandTotal > 0 && Math.abs(sum - grandTotal) > 0.01) {
          return res.status(400).json({
            error: `Cost allocation (${sum.toFixed(2)}) must equal grand total (${grandTotal.toFixed(2)})`,
            code: 'COST_ALLOCATION_MISMATCH',
          });
        }
        if (grandTotal <= 0 && sum <= 0) {
          return res.status(400).json({
            error: 'At least one cost allocation must be greater than zero',
            code: 'COST_ALLOCATION_EMPTY',
          });
        }

        // Persist the HRD-picked category alongside the per-unit split
        // for hotel bookings. We only accept the known category codes; an
        // unknown value is silently dropped so the requester's pre-existing
        // (or empty) allocationType isn't overwritten with junk.
        const allowedCategories = new Set([
          'marketing_domestic',
          'marketing_international',
          'administration',
          'promotions',
          'personnel',
        ]);
        const isHotelBookingType =
          meta.type === 'hotel_booking' || meta.type === 'external_hotel_booking';
        const cleanedAllocationType =
          isHotelBookingType && typeof allocationType === 'string' && allowedCategories.has(allocationType)
            ? allocationType
            : undefined;
        if (isHotelBookingType && !cleanedAllocationType) {
          return res.status(400).json({
            error: 'Allocation category is required for complimentary bookings',
            code: 'ALLOCATION_CATEGORY_REQUIRED',
          });
        }

        await supabaseAdmin
          .from('requests')
          .update({
            metadata: {
              ...meta,
              costAllocation: cleaned,
              ...(cleanedAllocationType ? { allocationType: cleanedAllocationType } : {}),
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', requestId);
      }
    }

    // -----------------------------------------------------------------
    // Apply the decision via the engine, with audit context.
    // -----------------------------------------------------------------
    const result = await ApprovalEngine.processApprovalAction(
      requestId,
      stepId,
      userId,
      action,
      comment ?? undefined,
      signatureUrl || undefined,
      {
        signatureType: resolvedSignatureType,
        signatureReference,
        authenticationMethod: 'session',
        authReference: null,
        ipAddress: getClientIp(req),
        deviceInfo: sanitizeDeviceInfo(deviceInfo, req),
      }
    );

    // Audit is a write-only log — record it after the response, not on the
    // critical path, so the approver isn't kept waiting on it.
    runInBackground(
      () =>
        audit(req, session.user, {
          category: 'transaction',
          action: action === 'approve' ? 'request.approved' : 'request.rejected',
          severity: action === 'approve' ? 'info' : 'notice',
          outcome: result.success ? 'success' : 'failure',
          targetType: 'request',
          targetId: requestId,
          requestId,
          details: {
            stepId,
            comment: comment || null,
            authenticationMethod: 'session',
            ...(result.success ? {} : { error: result.error }),
          },
        }),
      'approval:audit'
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(200).json({
      success: true,
      message: result.message || `Request ${action === 'approve' ? 'approved' : 'rejected'}`,
      decision: action === 'approve' ? 'approved' : 'rejected',
      authenticationMethod: 'session',
    });
  } catch (error: any) {
    console.error('Approval action error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Upload a manually drawn signature (data URL -> storage) and return the public URL. */
async function uploadManualSignature(
  userId: string,
  requestId: string,
  stepId: string,
  dataUrl: string
): Promise<string | null> {
  try {
    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!match) return null;
    const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const path = `manual/${userId}/${requestId}/${stepId}.${ext === 'jpeg' ? 'jpg' : ext}`;
    const { error } = await supabaseAdmin.storage
      .from(SIGNATURE_BUCKET)
      .upload(path, buffer, {
        contentType: `image/${ext}`,
        upsert: true,
      });
    if (error) {
      console.error('Failed to upload manual signature:', error);
      return null;
    }
    // Private bucket: persist the authenticated proxy URL for this object path.
    return pathSignatureProxyUrl(path);
  } catch (err) {
    console.error('uploadManualSignature error:', err);
    return null;
  }
}

function getClientIp(req: NextApiRequest): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff[0]) return xff[0];
  return (req.socket?.remoteAddress as string) || null;
}

/**
 * Strip anything potentially sensitive from the client-provided device info
 * before storing. We only want a small, well-known set of fingerprint-free
 * fields; anything else is dropped.
 */
function sanitizeDeviceInfo(
  raw: any,
  req: NextApiRequest
): Record<string, any> {
  const out: Record<string, any> = {};
  if (raw && typeof raw === 'object') {
    if (typeof raw.userAgent === 'string') out.userAgent = raw.userAgent.slice(0, 300);
    if (typeof raw.platform === 'string') out.platform = raw.platform.slice(0, 80);
    if (typeof raw.timezone === 'string') out.timezone = raw.timezone.slice(0, 80);
    if (typeof raw.language === 'string') out.language = raw.language.slice(0, 40);
  }
  // Fall back to the server-side user-agent header if the client didn't send one.
  if (!out.userAgent && req.headers['user-agent']) {
    out.userAgent = String(req.headers['user-agent']).slice(0, 300);
  }
  return out;
}
