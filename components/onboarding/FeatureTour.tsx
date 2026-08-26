import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * FeatureTour
 * -----------
 * An immersive, spotlight-style product tour. Each step points at a real UI
 * element (matched by a `data-tour` attribute) and dims everything else, while
 * a floating card explains the feature. The spotlight glides between targets.
 *
 * The dimming + highlight is a SINGLE element: a transparent box positioned
 * exactly over the target with a massive `box-shadow` spread. Everything the
 * shadow covers is dimmed; the box itself is the clear "hole". This is
 * pixel-accurate (no SVG mask desync) and animates cleanly.
 *
 * Mobile: the explanation renders as a bottom sheet, and steps whose target
 * lives in the (off-canvas) sidebar ask the host to open it first via
 * `onSidebar`, so the spotlight always lands on something visible.
 */

export interface TourStep {
  selector: string;
  title: string;
  body: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Target lives in the sidebar — open it on mobile before spotlighting. */
  sidebar?: boolean;
}

interface Props {
  steps: TourStep[];
  run: boolean;
  onFinish: () => void;
  /** Ask the host to open/close the mobile sidebar for sidebar-anchored steps. */
  onSidebar?: (open: boolean) => void;
}

const SPOT_PAD = 8;
const GAP = 14;
const CARD_W = 340;
const MOBILE_BP = 640;   // card becomes a bottom sheet below this
const SIDEBAR_BP = 1024; // matches Tailwind lg — sidebar is off-canvas below this

interface Rect { top: number; left: number; width: number; height: number }

/**
 * Effective CSS `zoom` factor on the page. The app applies `html { zoom: 0.9 }`
 * on desktop (≥1024px). Under `zoom`, getBoundingClientRect() returns already-
 * zoomed coordinates, but a `position: fixed` element re-applies the zoom to its
 * top/left/width/height — so we must divide our measured (visual) coordinates by
 * this factor when positioning the fixed overlay, or the spotlight lands offset.
 */
function detectZoom(): number {
  if (typeof document === 'undefined') return 1;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;width:100px;height:0;left:0;top:0;visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  const z = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return z > 0 ? z : 1;
}

export default function FeatureTour({ steps, run, onFinish, onSidebar }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [cardSize, setCardSize] = useState({ w: CARD_W, h: 180 });
  const cardRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<Rect | null>(null);

  const step = steps[index];

  // End the tour and make sure any sidebar we opened is closed again.
  const end = useCallback(() => {
    onSidebar?.(false);
    onFinish();
  }, [onSidebar, onFinish]);

  // Next/previous step whose target is present + not display:none. We accept
  // "in the DOM" rather than "has width now" so a momentarily 0-sized target
  // (mid-layout, or a sidebar still sliding in) never ends the tour early.
  const existingFrom = useCallback((start: number, dir: 1 | -1): number => {
    for (let i = start; i >= 0 && i < steps.length; i += dir) {
      const el = document.querySelector(steps[i].selector) as HTMLElement | null;
      if (el && (el.offsetParent !== null || el.getClientRects().length > 0)) return i;
    }
    return -1;
  }, [steps]);

  // Measure the target and update state ONLY when it actually moved. This lets
  // us run `measure` every animation frame (so the spotlight stays glued to the
  // target through late layout shifts — e.g. web-font load nudging nav items —
  // and scrolls) without re-rendering on every frame.
  const measure = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(step.selector) as HTMLElement | null;
    const clear = () => { if (rectRef.current) { rectRef.current = null; setRect(null); } };
    if (!el) { clear(); return; }
    const r = el.getBoundingClientRect();
    // A target scrolled/slid off-screen isn't worth spotlighting.
    if (r.width === 0 && r.height === 0) { clear(); return; }
    const nr = { top: r.top, left: r.left, width: r.width, height: r.height };
    const p = rectRef.current;
    const moved = !p ||
      Math.abs(p.top - nr.top) > 0.5 || Math.abs(p.left - nr.left) > 0.5 ||
      Math.abs(p.width - nr.width) > 0.5 || Math.abs(p.height - nr.height) > 0.5;
    if (moved) { rectRef.current = nr; setRect(nr); }
  }, [step]);

  // Track viewport size + the effective page zoom (both change at the 1024px
  // breakpoint where the app toggles `html { zoom: 0.9 }`).
  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setZoom(detectZoom());
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // On run / step change: reveal the sidebar if needed, wait for the target to
  // exist (it may still be rendering — e.g. the sidebar is blocked on RBAC
  // permissions loading), scroll it into view, then keep the spotlight glued to
  // it for a beat (covers the sidebar slide + smooth-scroll settle). Only skip a
  // step once we're confident its target genuinely won't appear.
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    let pollTimer = 0;
    let settle = 0;
    let raf = 0;
    let attempts = 0;

    const isPresent = (el: HTMLElement | null) =>
      !!el && (el.offsetParent !== null || el.getClientRects().length > 0);

    const activate = (el: HTMLElement, mobile: boolean) => {
      settle = window.setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }, mobile && step.sidebar ? 260 : 0);
      // Measure every frame while this step is active. `measure` only re-renders
      // when the target actually moves, so this keeps the spotlight glued
      // through scrolls, sidebar slides and late layout shifts, cheaply.
      const tick = () => {
        if (cancelled) return;
        measure();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const resolve = () => {
      if (cancelled) return;
      const mobile = window.innerWidth < SIDEBAR_BP;
      onSidebar?.(mobile && !!step.sidebar);

      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (isPresent(el)) { activate(el as HTMLElement, mobile); return; }

      // Target not here yet — poll briefly (up to ~2s) before giving up, so a
      // late-mounting nav item doesn't cause the step to be skipped.
      attempts += 1;
      if (attempts <= 20) { pollTimer = window.setTimeout(resolve, 100); return; }

      const nxt = existingFrom(index + 1, 1);
      if (nxt !== -1) setIndex(nxt);
      else end();
    };

    resolve();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(settle);
      cancelAnimationFrame(raf);
    };
  }, [run, index, step, existingFrom, measure, onSidebar, end]);

  // Measure the card so we can clamp it to the viewport (desktop).
  useLayoutEffect(() => {
    if (cardRef.current) {
      const r = cardRef.current.getBoundingClientRect();
      setCardSize({ w: r.width, h: r.height });
    }
  }, [index, rect, viewport.w]);

  const next = useCallback(() => {
    const n = existingFrom(index + 1, 1);
    if (n === -1) end();
    else setIndex(n);
  }, [existingFrom, index, end]);

  const prev = useCallback(() => {
    const p = existingFrom(index - 1, -1);
    if (p !== -1) setIndex(p);
  }, [existingFrom, index]);

  // Keyboard nav.
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, end, next, prev]);

  if (!run || typeof window === 'undefined' || !step) return null;

  const vw = viewport.w || window.innerWidth;
  const vh = viewport.h || window.innerHeight;
  const isMobile = vw < MOBILE_BP;
  // Divisor to convert our visual (getBoundingClientRect-space) coordinates into
  // the values a `position: fixed` element needs under the page's CSS zoom.
  const z = zoom || 1;

  const spot = rect
    ? {
        x: Math.max(6, rect.left - SPOT_PAD),
        y: Math.max(6, rect.top - SPOT_PAD),
        w: Math.min(rect.width + SPOT_PAD * 2, vw - 12),
        h: rect.height + SPOT_PAD * 2,
      }
    : null;

  // ---- card position ------------------------------------------------------
  let cardStyle: React.CSSProperties;
  if (isMobile) {
    // Bottom sheet — always fully on-screen, never fighting a tiny target.
    cardStyle = { position: 'fixed', left: 12, right: 12, bottom: 16, maxWidth: 460, margin: '0 auto' };
  } else {
    const placement = step.placement || 'bottom';
    let top = vh / 2 - cardSize.h / 2;
    let left = vw / 2 - cardSize.w / 2;
    if (spot) {
      if (placement === 'bottom') { top = spot.y + spot.h + GAP; left = spot.x + spot.w / 2 - cardSize.w / 2; }
      else if (placement === 'top') { top = spot.y - GAP - cardSize.h; left = spot.x + spot.w / 2 - cardSize.w / 2; }
      else if (placement === 'right') { left = spot.x + spot.w + GAP; top = spot.y + spot.h / 2 - cardSize.h / 2; }
      else if (placement === 'left') { left = spot.x - GAP - cardSize.w; top = spot.y + spot.h / 2 - cardSize.h / 2; }
      // Flip if the preferred side overflows.
      if (top + cardSize.h > vh - 12 && spot.y - GAP - cardSize.h > 12) top = spot.y - GAP - cardSize.h;
      if (left + cardSize.w > vw - 12 && spot.x - GAP - cardSize.w > 12) left = spot.x - GAP - cardSize.w;
    }
    top = Math.min(Math.max(12, top), vh - cardSize.h - 12);
    left = Math.min(Math.max(12, left), vw - cardSize.w - 12);
    // Convert visual coords → fixed-position coords (see detectZoom).
    cardStyle = { position: 'fixed', top: top / z, left: left / z, width: CARD_W };
  }

  const isLast = existingFrom(index + 1, 1) === -1;
  const isFirst = existingFrom(index - 1, -1) === -1;

  const overlay = (
    <div className="fixed inset-0 z-[140]" role="dialog" aria-label="Feature tour">
      {/* Dim + spotlight in one element (or a plain dim while measuring). */}
      {spot ? (
        <motion.div
          initial={false}
          animate={{ top: spot.y / z, left: spot.x / z, width: spot.w / z, height: spot.h / z }}
          transition={{ type: 'spring', stiffness: 300, damping: 33 }}
          style={{
            position: 'fixed',
            borderRadius: 14,
            pointerEvents: 'none',
            boxShadow: '0 0 0 3px rgba(201,165,116,0.95), 0 0 0 9999px rgba(20,18,15,0.72)',
          }}
        />
      ) : (
        <div className="fixed inset-0" style={{ background: 'rgba(20,18,15,0.72)', pointerEvents: 'none' }} />
      )}

      {/* Interaction blocker — keeps the app inert; tap doesn't advance. */}
      <div className="absolute inset-0" style={{ pointerEvents: 'auto' }} onClick={(e) => e.stopPropagation()} />

      {/* Floating explanation card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          ref={cardRef}
          initial={{ opacity: 0, y: isMobile ? 20 : 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: isMobile ? 20 : -8, scale: 0.98 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          style={{ ...cardStyle, pointerEvents: 'auto' } as any}
          className="rounded-2xl bg-surface shadow-2xl ring-1 ring-black/5 overflow-hidden"
        >
          <div className="h-1 w-full bg-gradient-to-r from-primary-500 to-accent-500" />
          <div className="p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-primary-500">
                Quick tour · {index + 1} of {steps.length}
              </span>
              <button
                onClick={end}
                className="text-xs font-medium text-text-muted hover:text-text-primary transition-colors"
              >
                Skip
              </button>
            </div>
            <h3 className="text-base font-bold tracking-tight text-text-primary">{step.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{step.body}</p>

            <div className="mt-4 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {steps.map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 rounded-full transition-all ${
                      i === index ? 'w-5 bg-primary-500' : i < index ? 'w-1.5 bg-accent-500' : 'w-1.5 bg-neutral-300'
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                {!isFirst && (
                  <button
                    onClick={prev}
                    className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={next}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700 transition-colors"
                >
                  {isLast ? 'Finish' : 'Next'}
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );

  return createPortal(overlay, document.body);
}
