import { ReactNode, useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import AppHeader from './AppHeader';
import Sidebar from './Sidebar';
import OnboardingFlow from '../onboarding/OnboardingFlow';
import FeatureTour, { TourStep } from '../onboarding/FeatureTour';
import { useSignatureCheck, useCurrentUser } from '@/hooks';
import { useRBAC } from '../../contexts/RBACContext';

// Post-onboarding walkthrough of the everyday features. Each step anchors to a
// real element via its `data-tour` attribute; missing targets are skipped.
const TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="requests"]',
    title: 'Raise a request',
    body: 'Start here to submit anything for approval — travel request,CAPEX form, complimentary hotel bookings and more. The Circle routes it to the right approvers automatically.',
    placement: 'right',
    sidebar: true,
  },
  {
    selector: '[data-tour="esign"]',
    title: 'Sign PDFs electronically',
    body: 'Need a signature on a document? Upload a PDF here to sign it yourself or send it to others for a legally binding e-signature — no printing required.',
    placement: 'right',
    sidebar: true,
  },
  {
    selector: '[data-tour="notifications"]',
    title: 'Stay in the loop',
    body: 'Approvals waiting on you, updates on your requests, and system alerts all land here. A dot means something new needs your attention.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="profile"]',
    title: 'Your profile & settings',
    body: 'Update your details, manage your signature, and register or remove devices used for verification — all from your profile menu.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="bugs"]',
    title: 'Spot something off?',
    body: 'Report a bug or share feedback anytime. It goes straight to the team so we can keep The Circle running smoothly.',
    placement: 'right',
    sidebar: true,
  },
];

interface AppLayoutProps {
  children: ReactNode;
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
  hideNav?: boolean;
  hideSidebar?: boolean;
  skipSignatureCheck?: boolean;
}

export default function AppLayout({
  children,
  title,
  showBack,
  onBack,
  hideNav = false,
  hideSidebar = false,
  skipSignatureCheck = false
}: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();

  // Persist the desktop collapsed state so it survives page navigations
  // (AppLayout remounts on every route change).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('sidebar:collapsed') === 'true');
    } catch {}
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('sidebar:collapsed', String(next)); } catch {}
      return next;
    });
  };
  const { hasSignature, loading: signatureLoading, refetch } = useSignatureCheck();
  const { user, loading: userLoading, needsProfileSetup, refetch: refetchUser } = useCurrentUser();
  const { hasPermission, loading: rbacLoading } = useRBAC();

  // Pages that opt out of the first-login onboarding / signature gate
  // (e.g. mobile signature capture, public e-sign, profile settings).
  const isSettingsPage = router.pathname === '/profile/settings';
  const shouldOnboard = !skipSignatureCheck && !isSettingsPage;

  // Decide ONCE whether to run the onboarding wizard. We must not re-evaluate
  // the data trigger on every render: as the user completes the profile and
  // signature steps mid-wizard, those flags flip and would unmount the flow
  // before they reach the device / "all set" screens. `null` = undecided.
  const [runOnboarding, setRunOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    if (!shouldOnboard) { setRunOnboarding(false); return; }
    if (runOnboarding !== null) return;              // already decided this session
    if (userLoading || signatureLoading || !user) return;

    let done = false;
    try { done = localStorage.getItem(`onboarding:done:${user.id}`) === 'true'; } catch {}

    setRunOnboarding(!done && (needsProfileSetup || !hasSignature));
  }, [shouldOnboard, runOnboarding, userLoading, signatureLoading, user, needsProfileSetup, hasSignature]);

  const handleOnboardingComplete = async () => {
    try { if (user) localStorage.setItem(`onboarding:done:${user.id}`, 'true'); } catch {}
    setRunOnboarding(false);
    await Promise.all([refetch(), refetchUser()]);
  };

  // ---- Post-onboarding feature tour ---------------------------------------
  // Runs once per user, only where the nav chrome (its anchor targets) exists.
  // "Tour done" is persisted server-side (user_preferences.tour_completed) so
  // it follows the user across browsers/devices; localStorage is kept only as a
  // fast, offline-friendly cache to avoid a flash before the server responds.
  const canTour = !hideSidebar && !hideNav;
  const [runTour, setRunTour] = useState(false);
  const tourDecided = useRef(false);

  useEffect(() => {
    if (runOnboarding !== false) return;   // still onboarding (or undecided) — wait
    if (tourDecided.current || !user || !canTour) return;
    if (rbacLoading) return;               // wait for permissions before deciding
    tourDecided.current = true;

    // The tour anchors to the Requests/E-Sign nav, which is hidden for users
    // without request permissions (e.g. the legal team). Skip it for them so it
    // never renders against missing targets.
    if (!hasPermission('requests.create')) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      // Fast path: if this browser already recorded completion, never re-run.
      let doneLocal = false;
      try { doneLocal = localStorage.getItem(`tour:done:${user.id}`) === 'true'; } catch {}
      if (doneLocal) return;

      // Otherwise consult the server flag so a user who finished the tour on
      // another device isn't shown it again. Fail open (show the tour) only if
      // the lookup errors — better a repeat than silently never showing it.
      try {
        const res = await fetch('/api/user/preferences');
        if (res.ok) {
          const data = await res.json();
          if (data?.preferences?.tourCompleted) {
            try { localStorage.setItem(`tour:done:${user.id}`, 'true'); } catch {}
            return;
          }
        }
      } catch { /* fall through and show the tour */ }

      if (cancelled) return;
      // Small delay so the onboarding overlay is gone and the anchors are painted.
      timer = setTimeout(() => { if (!cancelled) setRunTour(true); }, 600);
    })();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runOnboarding, user, canTour, rbacLoading, hasPermission]);

  const finishTour = () => {
    try { if (user) localStorage.setItem(`tour:done:${user.id}`, 'true'); } catch {}
    setRunTour(false);
    // Persist across devices. Best-effort — the localStorage cache above still
    // suppresses it on this browser even if the request fails.
    fetch('/api/user/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tourCompleted: true }),
    }).catch(() => {});
  };

  return (
    <div className="min-h-screen bg-background">
      {/* First-login onboarding wizard — welcome, HRIMS, signature, device, ready */}
      {runOnboarding && user && (
        <OnboardingFlow
          user={user}
          needsProfileSetup={needsProfileSetup}
          hasSignature={hasSignature}
          onComplete={handleOnboardingComplete}
        />
      )}

      {/* Post-onboarding guided tour of the everyday features */}
      {runTour && (
        <FeatureTour
          steps={TOUR_STEPS}
          run={runTour}
          onFinish={finishTour}
          onSidebar={setSidebarOpen}
        />
      )}

      {/* Sidebar for desktop and mobile */}
      {!hideSidebar && (
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
        />
      )}

      {/* Main content area */}
      <div className={`flex flex-col min-h-screen ${!hideSidebar ? (collapsed ? 'lg:pl-16' : 'lg:pl-64') : ''} transition-all duration-300`}>
        <AppHeader
          title={title}
          showBack={showBack}
          onBack={onBack}
          onMenuClick={() => setSidebarOpen(!sidebarOpen)}
          showMenuButton={!hideSidebar}
        />

        <main className={`flex-1 pb-4 max-w-8xl mx-auto w-full`}>
          {children}
        </main>
      </div>
    </div>
  );
}
