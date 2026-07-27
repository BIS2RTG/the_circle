import { useEffect, useRef, useState } from 'react';
import type ReactSignatureCanvas from 'react-signature-canvas';
import { useSignatureCanvasAutosize } from '@/hooks/useSignatureCanvasAutosize';

/**
 * SignatureSelector
 * -----------------
 * Compact tabbed control for choosing how to sign an approval. Two options:
 *
 *   - saved  -> use the user's pre-registered signature (default when available)
 *   - manual -> draw one right now on a canvas (accessibility: mouse / touch / stylus)
 *
 * Typed signatures are intentionally not offered — every signing event must
 * be backed by an actual signature artifact (a saved image or one drawn at
 * the moment of approval), not a font rendering of the user's typed name.
 *
 * The parent controls selection and supplies any ephemeral value (data URL for
 * manual). This component doesn't submit anything — the caller decides when
 * to apply the chosen signature.
 */

// react-signature-canvas is client-only. We import it lazily inside useEffect
// so it never runs during SSR. Next.js dynamic() doesn't forward refs to class
// components, which breaks .isEmpty() / .clear() / .getTrimmedCanvas().

export type SignatureChoice = 'saved' | 'manual';

export interface SignatureSelection {
  type: SignatureChoice;
  /** Data URL for 'manual', undefined for 'saved'. */
  data?: string;
}

interface Props {
  /** URL of the user's saved signature, if any. When absent, 'saved' is disabled. */
  savedSignatureUrl?: string | null;
  /** User's display name — kept for API compatibility (no longer used since 'typed' was removed). */
  userDisplayName?: string | null;
  value: SignatureSelection;
  onChange: (selection: SignatureSelection) => void;
  disabled?: boolean;
}

export default function SignatureSelector({
  savedSignatureUrl,
  value,
  onChange,
  disabled,
}: Props) {
  const canvasRef = useRef<ReactSignatureCanvas | null>(null);
  const [SigCanvas, setSigCanvas] = useState<typeof ReactSignatureCanvas | null>(null);

  // Lazy-load react-signature-canvas on the client only.
  useEffect(() => {
    import('react-signature-canvas').then((mod) => {
      setSigCanvas(() => mod.default);
    });
  }, []);

  // Keep the canvas backing store matched to its CSS size so strokes land
  // exactly under the pen/finger (no right-edge drift on wide containers).
  useSignatureCanvasAutosize(() => canvasRef.current, [SigCanvas, value.type]);

  // If the user has no saved signature, auto-switch to manual the first time.
  useEffect(() => {
    if (!savedSignatureUrl && value.type === 'saved') {
      onChange({ type: 'manual' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSignatureUrl]);

  const handleTabChange = (choice: SignatureChoice) => {
    if (disabled) return;
    if (choice === 'saved') onChange({ type: 'saved' });
    if (choice === 'manual') onChange({ type: 'manual', data: value.type === 'manual' ? value.data : undefined });
  };

  const handleCanvasEnd = () => {
    const sig = canvasRef.current;
    if (!sig) return;
    if (sig.isEmpty()) {
      onChange({ type: 'manual' });
      return;
    }
    // Use toDataURL directly from the signature_pad base class. The
    // getTrimmedCanvas() helper depends on 'trim-canvas' which has webpack
    // ESM compatibility issues — this avoids that dependency entirely.
    const dataUrl = sig.toDataURL('image/png');
    onChange({ type: 'manual', data: dataUrl });
  };

  const clearCanvas = () => {
    canvasRef.current?.clear();
    onChange({ type: 'manual' });
  };

  const TabButton = ({ choice, label, hint }: { choice: SignatureChoice; label: string; hint?: string }) => {
    const active = value.type === choice;
    const tabDisabled = disabled || (choice === 'saved' && !savedSignatureUrl);
    return (
      <button
        type="button"
        onClick={() => handleTabChange(choice)}
        disabled={tabDisabled}
        className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
          active
            ? 'bg-primary-600 text-white border-primary-600'
            : tabDisabled
            ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed'
            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
        }`}
        title={hint}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <TabButton
          choice="saved"
          label="Use saved"
          hint={savedSignatureUrl ? 'Use your registered signature' : 'No saved signature on file'}
        />
        <TabButton choice="manual" label="Draw" hint="Draw a new signature" />
      </div>

      <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 min-h-[220px]">
        {value.type === 'saved' && savedSignatureUrl && (
          <div className="flex items-center justify-center h-[200px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={savedSignatureUrl}
              alt="Your saved signature"
              className="max-h-[200px] max-w-full object-contain"
            />
          </div>
        )}

        {value.type === 'manual' && (
          <div>
            <div className="bg-white border border-dashed border-gray-300 rounded">
              {SigCanvas ? (
                <SigCanvas
                  ref={(ref: ReactSignatureCanvas | null) => { canvasRef.current = ref; }}
                  penColor="#111827"
                  // A slightly heavier pen makes the stroke read like ink and
                  // feels more natural on a larger pad.
                  minWidth={0.75}
                  maxWidth={2.75}
                  canvasProps={{
                    // No fixed width/height: the autosize hook keeps the
                    // backing store in sync with the CSS size + pixel ratio so
                    // the ink stays locked under the pen. A taller pad gives
                    // approvers more room to sign comfortably.
                    className: 'w-full h-[200px] rounded touch-none cursor-crosshair',
                    style: { touchAction: 'none' },
                  }}
                  onEnd={handleCanvasEnd}
                />
              ) : (
                <div className="w-full h-[200px] flex items-center justify-center text-gray-400 text-sm">
                  Loading...
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-gray-400">Sign inside the box above</span>
              <button
                type="button"
                onClick={clearCanvas}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
