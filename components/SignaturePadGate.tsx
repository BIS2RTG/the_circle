import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * SignaturePadGate
 * ----------------
 * Wraps a signature canvas and prevents drawing until the WHOLE pad is visible
 * in the viewport.
 *
 * The problem it solves: when a signature pad sits below the fold, users sign on
 * the sliver that's on-screen without scrolling to reveal the rest. On a
 * partially-visible canvas the strokes land above where the pen actually
 * touches (the canvas is taller than the visible area), so people complain the
 * pad is "too small" and that their signature "jumps upward". Forcing the full
 * pad on-screen before any stroke is accepted removes that mismatch.
 *
 * While the pad isn't fully visible, a tap/click anywhere on it is intercepted
 * (never reaching the canvas) and smoothly scrolls the pad into view instead.
 * Fails OPEN — if IntersectionObserver is unavailable, signing is never blocked.
 */
export default function SignaturePadGate({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fullyVisible, setFullyVisible] = useState(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setFullyVisible(true); // fail open — never block signing if we can't observe
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        // A pad taller than the viewport can never reach ratio 1 — never block
        // signing in that case (short screens / landscape phones), just require
        // it to be substantially on-screen.
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const tallerThanViewport = entry.boundingClientRect.height >= vh - 8;
        setFullyVisible(tallerThanViewport ? entry.intersectionRatio >= 0.9 : entry.intersectionRatio >= 0.99);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1] }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const reveal = () => {
    wrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div ref={wrapRef} className={`relative ${className || ''}`}>
      {children}
      {!fullyVisible && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded bg-white/85 backdrop-blur-[1px] px-4 text-center cursor-pointer"
          style={{ touchAction: 'none' }}
          // Swallow the first interaction and scroll the pad into view instead
          // of letting it start a stroke on a half-visible canvas.
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); reveal(); }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); reveal(); }}
          role="button"
          aria-label="Scroll to reveal the full signature pad before signing"
        >
          <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
          <p className="text-sm font-medium text-gray-700">Scroll to show the full signature pad before signing</p>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); reveal(); }}
            className="mt-1 px-3 py-1.5 text-sm font-semibold rounded-lg bg-primary-600 text-white hover:bg-primary-700 transition-colors"
          >
            Show full pad
          </button>
        </div>
      )}
    </div>
  );
}
