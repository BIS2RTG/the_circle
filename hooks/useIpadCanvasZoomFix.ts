import { useEffect, useState } from 'react';

/**
 * iPad-only signature-pad zoom correction.
 *
 * The desktop layout applies `html { zoom: 0.9 }` at >=1024px (styles/globals.css).
 * iPadOS matches that breakpoint (it presents as a desktop "Macintosh") AND —
 * unlike Blink — WebKit reports touch coordinates WITHOUT the CSS zoom applied,
 * while `getBoundingClientRect()` includes it. signature_pad derives each stroke
 * from `touch.clientY - rect.top`, so the two mismatched spaces make the ink land
 * well above the pen. iPhones (<1024px, no zoom) and desktop Chrome/Edge (Blink)
 * are unaffected, which is exactly why only iPads show the offset.
 *
 * NOTE: this is a DEVICE issue, not a browser-brand one. On iPadOS every browser
 * is required by Apple to use WebKit, so Chrome (CriOS) and Edge (EdgiOS) on an
 * iPad hit the exact same quirk as Safari — and, because they request the desktop
 * site by default, they trip the >=1024px zoom rule even more readily. The detection
 * below keys on the device (any iPad), so all three browsers are covered.
 *
 * Fix: on iPad ONLY, apply the reciprocal zoom to the signature-pad subtree so
 * its cumulative rendered zoom returns to 1.0. At an effective zoom of 1.0 the
 * canvas rect and the touch coordinates share the same space again and the pen
 * tracks the ink. Returns 1 (a no-op) on every other device, so nothing else
 * changes.
 */

// Keep in sync with the `html { zoom: … }` value in styles/globals.css.
const HTML_ZOOM_AT_DESKTOP = 0.9;
const DESKTOP_ZOOM_QUERY = '(min-width: 1024px)';

function isIpad(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua)) return true;
  // iPadOS 13+ presents as "Macintosh"; a Mac user-agent with a touch screen is
  // an iPad (touchscreen Macs don't exist).
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

/**
 * @returns the `zoom` factor to apply to the signature-pad wrapper — the
 * reciprocal of the active `html` zoom on iPad, or `1` (no-op) everywhere else.
 */
export function useIpadCanvasZoomFix(): number {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (typeof window === 'undefined' || !isIpad()) return;
    const mq = window.matchMedia(DESKTOP_ZOOM_QUERY);
    const apply = () => setZoom(mq.matches ? 1 / HTML_ZOOM_AT_DESKTOP : 1);
    apply();
    // Orientation / window changes flip the media query on and off.
    mq.addEventListener?.('change', apply);
    window.addEventListener('resize', apply);
    return () => {
      mq.removeEventListener?.('change', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);

  return zoom;
}
