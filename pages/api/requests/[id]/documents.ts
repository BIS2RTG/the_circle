import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';
import { audit } from '../../../../lib/auditLog';
import { isPermanentWatcherOf } from '../../../../lib/permanentWatchers';
import { assistantCanActOn } from '../../../../lib/assistantAssignments';
import { getUserRBACProfile, hasPermission, PERMISSIONS } from '../../../../lib/rbac';
import formidable from 'formidable';
import * as fs from 'fs';
import * as path from 'path';

export const config = {
  api: {
    bodyParser: false,
  },
};

const STORAGE_BUCKET = 'quotations';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerSession(req, res, authOptions);
    
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const userId = user.id;
    const { id: requestId } = req.query;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    // Verify the request exists and belongs to the organization
    const { data: request, error: requestError } = await supabaseAdmin
      .from('requests')
      .select(`
        id, 
        creator_id,
        metadata,
        request_steps (
          id,
          approver_user_id,
          status
        )
      `)
      .eq('id', requestId)
      .eq('organization_id', organizationId)
      .single();

    if (requestError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Relationship checks. Viewing keeps the sequential model (an approver can't
    // peek before their turn); permanent watchers get read-only view. Uploading
    // is allowed for anyone in the request's scope — the creator, ANY approver on
    // the chain (even before their turn), or a per-request watcher — but NOT a
    // permanent watcher (read-only) or an unrelated user.
    const isCreator = request.creator_id === userId;

    const watcherIds = request.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) =>
      typeof w === 'string' ? w === userId : w?.id === userId
    );

    const userStep = request.request_steps?.find(
      (step: any) => step.approver_user_id === userId
    );
    const canApproverView = userStep && userStep.status !== 'waiting';

    const isPermanentWatcher = await isPermanentWatcherOf(userId, organizationId, request as any);

    // An assistant with the `can_upload` capability for this request's creator
    // or on-behalf principal may also attach documents.
    const isUploadAssistant =
      !isCreator && (await assistantCanActOn(userId, organizationId, request as any, 'can_upload'));

    let canView = isCreator || isWatcher || canApproverView || isPermanentWatcher || isUploadAssistant;
    // Super admins / requests.view_all holders can view (not upload) any request's docs.
    if (!canView && req.method === 'GET') {
      const rbac = await getUserRBACProfile(userId);
      if (rbac.is_super_admin || hasPermission(rbac, PERMISSIONS.REQUESTS_VIEW_ALL)) canView = true;
    }
    const canUpload = isCreator || isWatcher || !!userStep || isUploadAssistant; // any approver + upload-assistant, not permanent watchers

    if (req.method === 'GET' && !canView) {
      if (userStep && userStep.status === 'waiting') {
        return res.status(403).json({
          error: 'This request is not yet ready for your review.',
          code: 'APPROVAL_NOT_YOUR_TURN',
        });
      }
      return res.status(403).json({ error: 'You do not have permission to access this request' });
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && !canUpload) {
      return res.status(403).json({ error: 'You do not have permission to change this request\'s documents' });
    }

    if (req.method === 'GET') {
      // Get all documents for this request
      const { data: documents, error } = await supabaseAdmin
        .from('documents')
        .select('*')
        .eq('request_id', requestId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching documents:', error);
        return res.status(200).json({ documents: [] });
      }

      // Resolve uploader display names in one query (avoids FK-embed fragility).
      const uploaderIds = Array.from(
        new Set((documents || []).map((d: any) => d.uploaded_by).filter(Boolean))
      );
      const uploaderMap: Record<string, { id: string; display_name: string; email: string }> = {};
      if (uploaderIds.length > 0) {
        const { data: uploaders } = await supabaseAdmin
          .from('app_users')
          .select('id, display_name, email')
          .in('id', uploaderIds);
        for (const u of uploaders || []) uploaderMap[u.id] = u as any;
      }

      // Generate signed URLs for each document
      const documentsWithUrls = await Promise.all(
        (documents || []).map(async (doc) => {
          const uploader = doc.uploaded_by ? uploaderMap[doc.uploaded_by] || null : null;
          try {
            const { data: signedUrl } = await supabaseAdmin.storage
              .from(STORAGE_BUCKET)
              .createSignedUrl(doc.storage_path, 3600); // 1 hour expiry

            return {
              ...doc,
              uploader,
              download_url: signedUrl?.signedUrl || null,
            };
          } catch (e) {
            return { ...doc, uploader, download_url: null };
          }
        })
      );

      return res.status(200).json({ documents: documentsWithUrls });
    }

    if (req.method === 'POST') {
      // Parse the multipart form data
      const form = formidable({
        maxFileSize: 10 * 1024 * 1024, // 10MB limit
        keepExtensions: true,
      });

      const [fields, files] = await form.parse(req);
      const file = files.file?.[0];

      if (!file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      // Optional label + description for the supporting document.
      const label = (Array.isArray(fields.label) ? fields.label[0] : fields.label) || null;
      const description = (Array.isArray(fields.description) ? fields.description[0] : fields.description) || null;

      // Read the file
      const fileBuffer = fs.readFileSync(file.filepath);
      const originalFilename = file.originalFilename || 'document';
      const mimeType = file.mimetype || 'application/octet-stream';
      const fileSize = file.size;

      // Generate a unique storage path
      const fileExtension = path.extname(originalFilename);
      const storagePath = `${organizationId}/${requestId}/${Date.now()}-${Math.random().toString(36).substring(7)}${fileExtension}`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        return res.status(500).json({ error: `Failed to upload file: ${uploadError.message}` });
      }

      // Create document record in database
      const { data: document, error: dbError } = await supabaseAdmin
        .from('documents')
        .insert({
          request_id: requestId,
          filename: originalFilename,
          storage_path: storagePath,
          file_size: fileSize,
          mime_type: mimeType,
          label,
          description,
          uploaded_by: userId,
        })
        .select()
        .single();

      if (dbError) {
        // Try to clean up the uploaded file
        await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
        console.error('Database insert error:', dbError);
        return res.status(500).json({ error: `Failed to save document record: ${dbError.message}` });
      }

      // Record who uploaded what, when — into the immutable audit trail.
      await audit(req, user, {
        category: 'transaction',
        action: 'request.document_uploaded',
        targetType: 'request',
        targetId: requestId,
        requestId,
        details: {
          documentId: document.id,
          filename: originalFilename,
          label: label || null,
          actingFor: isUploadAssistant ? (request.metadata?.onBehalfOf?.userId || request.creator_id) : undefined,
        },
      });

      // Clean up temp file
      try {
        fs.unlinkSync(file.filepath);
      } catch (e) {
        // Ignore cleanup errors
      }

      // Get signed URL for the new document
      const { data: signedUrl } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(storagePath, 3600);

      return res.status(201).json({
        document: {
          ...document,
          download_url: signedUrl?.signedUrl || null,
        },
      });
    }

    if (req.method === 'DELETE') {
      const { documentId } = req.query;

      if (!documentId || typeof documentId !== 'string') {
        return res.status(400).json({ error: 'Document ID is required' });
      }

      // Get the document
      const { data: document, error: fetchError } = await supabaseAdmin
        .from('documents')
        .select('*')
        .eq('id', documentId)
        .eq('request_id', requestId)
        .single();

      if (fetchError || !document) {
        return res.status(404).json({ error: 'Document not found' });
      }

      // Delete from storage
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([document.storage_path]);

      // Delete from database
      const { error: deleteError } = await supabaseAdmin
        .from('documents')
        .delete()
        .eq('id', documentId);

      if (deleteError) throw deleteError;

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Documents API error:', error);
    return res.status(500).json({ error: error.message || 'Failed to process request' });
  }
}
