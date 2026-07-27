import { signIn, useSession } from "next-auth/react";
import Head from "next/head";
import { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Loader from "../components/Loader";

export const getServerSideProps: GetServerSideProps = async () => {
  return { props: {} };
};

const HEADLINE =
  "Driving RTG's digital transformation through workflow automation.";

// Pages a user may choose as their post-login landing page (must match the
// options in My Settings). Anything else falls back to the dashboard.
const ALLOWED_LANDING_PAGES = [
  '/dashboard',
  '/requests/my-requests',
  '/requests/drafts',
  '/approvals',
  '/notifications',
];

/** Resolve the signed-in user's preferred landing page, defaulting safely. */
async function resolveLandingPage(): Promise<string> {
  try {
    const res = await fetch('/api/user/preferences');
    if (res.ok) {
      const data = await res.json();
      const lp = data?.preferences?.landingPage;
      if (typeof lp === 'string' && ALLOWED_LANDING_PAGES.includes(lp)) return lp;
    }
  } catch {
    // fall through to default
  }
  return '/dashboard';
}

/* ---------- Antigravity Canvas (Matter.js) ---------- */
function AntigravityCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const Matter = await import("matter-js");
      if (cancelled || !containerRef.current || !canvasRef.current) return;

      const { Engine, World, Bodies, Body, Runner, Events } = Matter;

      const container = containerRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      let width = container.clientWidth || window.innerWidth;
      let height = container.clientHeight || window.innerHeight;

      const resize = () => {
        width = container.clientWidth || window.innerWidth;
        height = container.clientHeight || window.innerHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      resize();

      const engine = Engine.create();
      engine.gravity.x = 0;
      engine.gravity.y = 0;
      engine.positionIterations = 6;
      engine.velocityIterations = 4;

      // Soft walls far outside so shapes stay in frame
      const wallThickness = 200;
      const walls = [
        Bodies.rectangle(width / 2, -wallThickness / 2, width + 400, wallThickness, { isStatic: true }),
        Bodies.rectangle(width / 2, height + wallThickness / 2, width + 400, wallThickness, { isStatic: true }),
        Bodies.rectangle(-wallThickness / 2, height / 2, wallThickness, height + 400, { isStatic: true }),
        Bodies.rectangle(width + wallThickness / 2, height / 2, wallThickness, height + 400, { isStatic: true }),
      ];
      World.add(engine.world, walls);

      type Shape = {
        body: Matter.Body;
        radius: number;
        color: string;
        rotation: number;
        rotationSpeed: number;
      };

      const palette = [
        "rgba(154, 117, 69, 0.35)",   // brand brown
        "rgba(201, 165, 116, 0.38)",  // warm gold
        "rgba(255, 255, 255, 0.55)",  // translucent warm white
        "rgba(184, 147, 90, 0.25)",   // tan
        "rgba(212, 180, 131, 0.28)",  // soft beige
      ];

      const isMobile = width < 640;
      const shapeCount = isMobile
        ? 7
        : Math.min(18, Math.max(10, Math.floor((width * height) / 90000)));
      const maxR = isMobile ? Math.min(42, width * 0.1) : Math.min(90, width * 0.14);
      const minR = isMobile ? Math.max(12, maxR * 0.4) : Math.max(18, maxR * 0.35);
      const shapes: Shape[] = [];

      for (let i = 0; i < shapeCount; i++) {
        const radius = minR + Math.random() * (maxR - minR);
        const body = Bodies.circle(
          Math.random() * width,
          Math.random() * height,
          radius,
          {
            frictionAir: 0.01,
            friction: 0,
            restitution: 0.9,
            density: 0.0008,
          }
        );
        Body.setVelocity(body, {
          x: (Math.random() - 0.5) * 1.2,
          y: (Math.random() - 0.5) * 1.2,
        });
        World.add(engine.world, body);
        shapes.push({
          body,
          radius,
          color: palette[i % palette.length],
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.015,
        });
      }

      // Mouse repulsion — with smoothed tracking + velocity
      const mouse = {
        x: -9999,
        y: -9999,
        tx: -9999,
        ty: -9999,
        vx: 0,
        vy: 0,
        active: false,
      };
      const onMove = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        mouse.tx = e.clientX - rect.left;
        mouse.ty = e.clientY - rect.top;
        if (!mouse.active) {
          mouse.x = mouse.tx;
          mouse.y = mouse.ty;
        }
        mouse.active = true;
      };
      const onLeave = () => {
        mouse.active = false;
        mouse.x = -9999;
        mouse.y = -9999;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseout", onLeave);

      Events.on(engine, "beforeUpdate", () => {
        // Smooth mouse tracking + derive velocity for "drag wake" effect
        if (mouse.active) {
          const prevX = mouse.x;
          const prevY = mouse.y;
          mouse.x += (mouse.tx - mouse.x) * 0.25;
          mouse.y += (mouse.ty - mouse.y) * 0.25;
          mouse.vx = mouse.x - prevX;
          mouse.vy = mouse.y - prevY;
        }
        const mouseSpeed = Math.hypot(mouse.vx, mouse.vy);

        for (const s of shapes) {
          if (mouse.active) {
            const dx = s.body.position.x - mouse.x;
            const dy = s.body.position.y - mouse.y;
            const distSq = dx * dx + dy * dy;
            const influence = 320;
            if (distSq < influence * influence && distSq > 1) {
              const dist = Math.sqrt(distSq);
              const falloff = 1 - dist / influence;
              // Non-linear ease-out for snappier near-field repulsion
              const ease = falloff * falloff;
              const base = 0.006 * ease;
              const speedBoost = 1 + Math.min(mouseSpeed * 0.25, 3);

              // Push away (stronger)
              Body.applyForce(s.body, s.body.position, {
                x: (dx / dist) * base * speedBoost,
                y: (dy / dist) * base * speedBoost,
              });
              // Swirl (perpendicular, scaled by proximity)
              Body.applyForce(s.body, s.body.position, {
                x: (-dy / dist) * base * 0.7,
                y: (dx / dist) * base * 0.7,
              });
              // Drag wake — shapes are nudged along the mouse direction
              Body.applyForce(s.body, s.body.position, {
                x: mouse.vx * 0.00018 * ease,
                y: mouse.vy * 0.00018 * ease,
              });
              // Spin up rotation near cursor
              s.rotationSpeed += (Math.random() - 0.5) * 0.002 * ease;
            }
          }

          // Velocity clamp for stability
          const maxV = 6;
          const vx = s.body.velocity.x;
          const vy = s.body.velocity.y;
          const vMag = Math.hypot(vx, vy);
          if (vMag > maxV) {
            Body.setVelocity(s.body, { x: (vx / vMag) * maxV, y: (vy / vMag) * maxV });
          } else {
            Body.setVelocity(s.body, { x: vx * 0.992, y: vy * 0.992 });
          }

          // Rotation damping back toward gentle drift
          s.rotationSpeed *= 0.98;
          if (Math.abs(s.rotationSpeed) < 0.003) {
            s.rotationSpeed += (Math.random() - 0.5) * 0.0008;
          }
          s.rotation += s.rotationSpeed;
        }
      });

      const runner = Runner.create();
      Runner.run(runner, engine);

      let rafId = 0;
      const render = () => {
        ctx.clearRect(0, 0, width, height);
        for (const s of shapes) {
          const { x, y } = s.body.position;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(s.rotation);

          // Rings only — outer stroke with gradient, inner highlight
          ctx.strokeStyle = s.color;
          ctx.lineWidth = Math.max(1, s.radius * 0.05);
          ctx.beginPath();
          ctx.arc(0, 0, s.radius * 0.85, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.lineWidth = Math.max(0.5, s.radius * 0.02);
          ctx.beginPath();
          ctx.arc(0, 0, s.radius * 0.72, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        rafId = requestAnimationFrame(render);
      };
      rafId = requestAnimationFrame(render);

      const onResize = () => {
        resize();
        Body.setPosition(walls[0], { x: width / 2, y: -wallThickness / 2 });
        Body.setPosition(walls[1], { x: width / 2, y: height + wallThickness / 2 });
        Body.setPosition(walls[2], { x: -wallThickness / 2, y: height / 2 });
        Body.setPosition(walls[3], { x: width + wallThickness / 2, y: height / 2 });
      };
      window.addEventListener("resize", onResize);

      // Also observe container size (mobile address bar, orientation)
      const ro = new ResizeObserver(() => onResize());
      ro.observe(container);

      cleanup = () => {
        ro.disconnect();
        cancelAnimationFrame(rafId);
        Runner.stop(runner);
        World.clear(engine.world, false);
        Engine.clear(engine);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseout", onLeave);
        window.removeEventListener("resize", onResize);
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

/* ---------- Typewriter ---------- */
function useTypewriter(text: string, speed = 28, startDelay = 250) {
  const [output, setOutput] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const start = setTimeout(() => {
      const tick = () => {
        i++;
        setOutput(text.slice(0, i));
        if (i >= text.length) {
          setDone(true);
          return;
        }
        timer = setTimeout(tick, speed);
      };
      tick();
    }, startDelay);
    return () => {
      clearTimeout(start);
      clearTimeout(timer!);
    };
  }, [text, speed, startDelay]);

  return { output, done };
}

/* ---------- Page ---------- */
export default function Home() {
  const { status } = useSession();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  // A deep link an unauthenticated user was sent to (e.g. an approval email →
  // /requests/{id}). We forward it through sign-in so they land there, not the
  // dashboard. Only internal, single-slash paths are honoured.
  const rawCallback = typeof router.query.callbackUrl === 'string' ? router.query.callbackUrl : null;
  const callbackUrl = rawCallback && rawCallback.startsWith('/') && !rawCallback.startsWith('//') ? rawCallback : null;
  const { output, done } = useTypewriter(HEADLINE);

  // Staging-only demo login. NEXT_PUBLIC_DEMO_MODE is set only on the staging
  // deployment, so this form (and the credentials provider behind it) never
  // appears in production.
  const demoEnabled = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const [demoEmail, setDemoEmail] = useState("");
  const [demoPassword, setDemoPassword] = useState("");
  const [demoError, setDemoError] = useState("");
  const [demoLoading, setDemoLoading] = useState(false);

  const handleDemoLogin = async (e: FormEvent) => {
    e.preventDefault();
    setDemoError("");
    setDemoLoading(true);
    const res = await signIn("credentials", {
      email: demoEmail,
      password: demoPassword,
      redirect: false,
    });
    if (res?.ok) {
      router.replace(callbackUrl || await resolveLandingPage());
    } else {
      setDemoError("Invalid demo credentials");
      setDemoLoading(false);
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      (async () => { router.replace(callbackUrl || await resolveLandingPage()); })();
    }
  }, [status, router, callbackUrl]);

  if (!mounted || status === "loading" || status === "authenticated") {
    return <Loader />;
  }

  return (
    <>
      <Head>
        <title>The Circle — Approval Workflow Engine</title>
        <meta
          name="description"
          content="The fast, reliable, audit-ready workflow engine powering Rainbow Tourism Group's digital transformation."
        />
      </Head>

      <main className="relative h-[100dvh] w-full overflow-hidden bg-white text-gray-900 selection:bg-[#9A7545] selection:text-white flex flex-col">
        {/* Ambient wash */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-1/3 -right-1/4 w-[70vw] h-[70vw] rounded-full bg-gradient-to-br from-[#9A7545]/15 to-[#C9A574]/15 blur-[120px]" />
          <div className="absolute -bottom-1/3 -left-1/4 w-[70vw] h-[70vw] rounded-full bg-gradient-to-tr from-[#C9A574]/15 to-[#9A7545]/10 blur-[120px]" />
        </div>

        {/* Physics canvas — only after typewriter is done */}
        <AnimatePresence>
          {done && (
            <motion.div
              key="canvas"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.2, ease: "easeOut" }}
              className="absolute inset-0"
            >
              <AntigravityCanvas />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top brand bar */}
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: done ? 1 : 0, y: done ? 0 : -10 }}
          transition={{ duration: 0.6, delay: done ? 0.1 : 0 }}
          className="relative z-20 flex items-center justify-between px-4 sm:px-10 py-3 sm:py-4 shrink-0"
        >
          <div className="flex items-center gap-3">
            <svg className="w-8 h-8 sm:w-9 sm:h-9" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="brandGradientLogin" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#9A7545" />
                  <stop offset="100%" stopColor="#C9A574" />
                </linearGradient>
              </defs>
              <path
                d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z"
                fill="url(#brandGradientLogin)"
              />
            </svg>
            <span className="font-bold text-lg sm:text-xl tracking-tight text-gray-900">The Circle</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/RTG_LOGO.png"
            alt="Rainbow Tourism Group"
            className="h-10 sm:h-12 w-auto object-contain"
          />
        </motion.header>

        {/* Hero */}
        <section className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center gap-10 sm:gap-14 px-4 sm:px-6 text-center">
          <h1 className="max-w-4xl text-[22px] leading-[1.3] sm:text-4xl sm:leading-[1.2] lg:text-5xl font-semibold tracking-tight text-gray-900">
            <span>{output}</span>
            <span
              className={`inline-block w-[2px] h-[1em] align-[-0.15em] ml-1 bg-gradient-to-b from-[#9A7545] to-[#C9A574] ${
                done ? "opacity-0" : "animate-pulse"
              }`}
            />
          </h1>

          {/* Sign in button — always mounted (stable layout), animated in after typing */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: done ? 1 : 0, y: done ? 0 : 40 }}
            transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: done ? 0.6 : 0 }}
            className="flex flex-col items-center w-full max-w-sm mx-auto"
          >
            <button
              onClick={() => signIn("azure-ad", callbackUrl ? { callbackUrl } : undefined)}
              disabled={!done}
              className="group relative w-full overflow-hidden rounded-xl bg-gray-900 px-6 py-4 text-white font-semibold shadow-xl shadow-gray-900/10 transition-all hover:bg-gray-800 active:scale-[0.985] focus:outline-none focus:ring-2 focus:ring-[#9A7545] focus:ring-offset-2 disabled:pointer-events-none"
            >
              <span className="relative z-10 flex items-center justify-center gap-3">
                <svg className="w-5 h-5" viewBox="0 0 21 21" fill="currentColor">
                  <path d="M0 0h10v10H0V0zm11 0h10v10H11V0zM0 11h10v10H0V11zm11 0h10v10H11V11z" />
                </svg>
                Sign in with Microsoft
              </span>
              <span className="absolute inset-0 translate-y-full bg-gradient-to-r from-[#9A7545] to-[#C9A574] transition-transform duration-500 group-hover:translate-y-0" />
            </button>
            <p className="mt-4 text-center text-[11px] text-gray-400">
              By signing in, you agree to our{" "}
              <a
                href="/legal/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9A7545] hover:underline"
              >
                Terms
              </a>{" "}
              and{" "}
              <a
                href="/legal/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9A7545] hover:underline"
              >
                Privacy Policy
              </a>.
            </p>

            {demoEnabled && (
              <div className="mt-6 w-full">
                <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-gray-400">
                  <span className="h-px flex-1 bg-gray-200" />
                  <span>Demo access</span>
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
                <form onSubmit={handleDemoLogin} className="mt-4 flex flex-col gap-3">
                  <input
                    type="email"
                    required
                    autoComplete="username"
                    placeholder="Demo email"
                    value={demoEmail}
                    onChange={(e) => setDemoEmail(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white/80 px-4 py-3 text-sm text-gray-900 outline-none focus:border-[#9A7545] focus:ring-2 focus:ring-[#9A7545]/30"
                  />
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="Password"
                    value={demoPassword}
                    onChange={(e) => setDemoPassword(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white/80 px-4 py-3 text-sm text-gray-900 outline-none focus:border-[#9A7545] focus:ring-2 focus:ring-[#9A7545]/30"
                  />
                  {demoError && (
                    <p className="text-center text-[12px] text-red-500">{demoError}</p>
                  )}
                  <button
                    type="submit"
                    disabled={demoLoading}
                    className="w-full rounded-xl border border-[#9A7545]/40 bg-white px-6 py-3 text-sm font-semibold text-[#9A7545] transition-all hover:bg-[#9A7545]/5 active:scale-[0.985] disabled:opacity-60"
                  >
                    {demoLoading ? "Signing in…" : "Sign in to demo"}
                  </button>
                </form>
              </div>
            )}
          </motion.div>
        </section>

        {/* Footer — floating, no background, so physics canvas covers the area */}
        <motion.footer
          initial={{ opacity: 0 }}
          animate={{ opacity: done ? 1 : 0 }}
          transition={{ duration: 0.8, delay: done ? 0.4 : 0 }}
          className="pointer-events-none absolute bottom-3 inset-x-0 z-10 flex items-center justify-center text-[11px] text-gray-400"
        >
          <span>© {new Date().getFullYear()} Rainbow Tourism Group</span>
        </motion.footer>
      </main>
    </>
  );
}
