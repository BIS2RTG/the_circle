import { useEffect } from 'react';
import type ReactSignatureCanvas from 'react-signature-canvas';

/**
 * Keeps a react-signature-canvas backing store in sync with its on-screen
 * (CSS) size and the device pixel ratio.
 *
 * Why: a <canvas> has an internal pixel size (width/height attributes) that is
 * independent of its CSS size. When the two differ — e.g. a fixed
 * `width: 400` canvas stretched with `w-full` — the pointer position and the
 * rendered stroke diverge, so ink appears centimetres away from the pen or
 * finger. react-signature-canvas only self-corrects once on mount and never
 * when a fixed width/height is passed, so any container resize (orientation
 * change, sidebar toggle, mobile URL bar collapse) reintroduces the offset.
 *
 * Usage: do NOT pass width/height in canvasProps; size the canvas with CSS
 * and call this hook with a getter for the component instance. Existing
 * strokes are preserved across resizes via toData()/fromData().
 *
 * @param getInstance returns the mounted ReactSignatureCanvas (or null)
 * @param deps re-attach when the canvas (re)mounts, e.g. [activeTab]
 */
export function useSignatureCanvasAutosize(
  getInstance: () => ReactSignatureCanvas | null,
  deps: unknown[] = []
) {
  useEffect(() => {
    const sig = getInstance();
    if (!sig) return;

    let canvas: HTMLCanvasElement;
    try {
      canvas = sig.getCanvas();
    } catch {
      return;
    }

    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      // Measure with getBoundingClientRect(), NOT offsetWidth/offsetHeight.
      // signature_pad derives every stroke coordinate from
      // `event.clientX/Y - canvas.getBoundingClientRect().left/top`, so the
      // backing store must be sized in that SAME coordinate space. Under the
      // desktop `html { zoom: 0.9 }` rule these two measurements diverge
      // (offsetWidth is the unzoomed layout width, getBoundingClientRect is the
      // post-zoom visual width). Sizing off offsetWidth then made the ink drift
      // further from the pen the closer you got to the right/bottom edge. Using
      // the rect keeps the pen locked to the stroke at any zoom.
      const rect = canvas.getBoundingClientRect();
      const cssWidth = rect.width;
      const cssHeight = rect.height;
      // Hidden (display:none) containers report 0 — the observer will fire
      // again once the canvas becomes visible.
      if (!cssWidth || !cssHeight) return;
      const targetW = Math.round(cssWidth * ratio);
      const targetH = Math.round(cssHeight * ratio);
      if (canvas.width === targetW && canvas.height === targetH) return;

      // Point groups are stored in CSS-pixel coordinates, so they can be
      // replayed after the backing store changes without losing the drawing.
      let data: ReturnType<ReactSignatureCanvas['toData']> | null = null;
      try {
        data = sig.toData();
      } catch {
        /* no strokes yet */
      }

      // Assigning width/height resets the context, so the scale below is
      // never applied twice.
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.getContext('2d')?.scale(ratio, ratio);
      sig.clear();
      if (data && data.length > 0) {
        try {
          sig.fromData(data);
        } catch {
          /* stroke restore is best-effort */
        }
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
