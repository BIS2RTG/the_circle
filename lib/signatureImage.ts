/**
 * Signature image normalisation.
 *
 * Signatures are captured as the FULL signing-pad canvas (see
 * SignatureSelector — `toDataURL` without trimming). A person who signs small
 * in a large pad therefore produces a PNG that is mostly empty transparent
 * space, so the ink renders tiny wherever the image is fit into a display box
 * (approval previews, the saved-signature panel, PDFs).
 *
 * `trimSignatureBuffer` crops that empty margin down to the ink's bounding box
 * (plus a hair of breathing room) so the signature fills its frame — making it
 * appear much larger without changing display code. This is applied at SERVE
 * time by the signature proxy, so it is non-destructive: the stored object is
 * never modified and the effect is fully reversible by reverting the caller.
 */

import sharp from 'sharp';

/**
 * Crop the transparent (or uniform-background) margin around a signature so the
 * ink fills the frame. Returns a new buffer, or the ORIGINAL buffer unchanged
 * if the image can't be processed or trimming would gain nothing — this helper
 * must never throw or return an empty image on the serving path.
 *
 * @param buffer  the raw signature image bytes (png/jpeg)
 * @param padRatio fraction of the trimmed size to re-add as breathing room
 */
export async function trimSignatureBuffer(buffer: Buffer, padRatio = 0.06): Promise<Buffer> {
  if (!buffer || buffer.length === 0) return buffer;
  try {
    const img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    // Only worth trimming raster images with real dimensions.
    if (!meta.width || !meta.height) return buffer;

    // Trim the border region (transparent for PNGs, corner-colour for JPEGs).
    const trimmed = sharp(buffer, { failOn: 'none' }).trim({ threshold: 10 });
    const { data, info } = await trimmed.toBuffer({ resolveWithObject: true });

    // Nothing meaningful was removed (blank / already-tight image): keep original.
    if (!info.width || !info.height) return buffer;
    if (info.width >= meta.width && info.height >= meta.height) return buffer;

    if (padRatio <= 0) return data;

    // Re-add a small transparent margin so the ink doesn't touch the edges.
    const pad = Math.max(2, Math.round(Math.min(info.width, info.height) * padRatio));
    const padded = await sharp(data, { failOn: 'none' })
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();
    return padded;
  } catch {
    // Any processing failure: serve the original bytes untouched.
    return buffer;
  }
}
