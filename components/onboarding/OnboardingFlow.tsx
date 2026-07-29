import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { useSession } from 'next-auth/react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useSuppressToastsWhileOpen } from '../ui/ToastProvider';
import { friendlyWebauthnError } from '@/lib/webauthnErrors';

const SignaturePad = dynamic(() => import('../SignaturePad'), {
  ssr: false,
  loading: () => <div className="h-40 bg-neutral-50 animate-pulse rounded-xl" />,
});

interface HrimsEmployee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  job_title: string | null;
  department_id: string | null;
  business_unit_id: string;
}
interface NamedRecord { id: string; name: string; code?: string }
interface DirectoryUser { id: string; display_name: string | null; email: string; job_title?: string | null }

/** Collapse departments that share a name (they repeat across business units). */
function dedupeByName(records: NamedRecord[]): NamedRecord[] {
  const seen = new Set<string>();
  const out: NamedRecord[] = [];
  for (const r of records) {
    const key = (r.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

interface OnboardingFlowProps {
  user: { id: string; department_id?: string | null; business_unit_id?: string | null };
  needsProfileSetup: boolean;
  hasSignature: boolean;
  onComplete: () => void;
}

const STEPS = ['Welcome', 'HRIMS', 'Signature', 'Device', 'Ready'] as const;

const slide = {
  enter: (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -60 : 60, opacity: 0 }),
};

export default function OnboardingFlow({ user, needsProfileSetup, hasSignature, onComplete }: OnboardingFlowProps) {
  useSuppressToastsWhileOpen(true);
  const { data: session } = useSession();

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  // Step 1 — consent
  const [consent, setConsent] = useState(false);

  // Step 2 — HRIMS / profile
  const [hrimsLoading, setHrimsLoading] = useState(true);
  const [hrimsFound, setHrimsFound] = useState(false);
  const [hrimsEmployee, setHrimsEmployee] = useState<HrimsEmployee | null>(null);
  const [hrimsDepartment, setHrimsDepartment] = useState<NamedRecord | null>(null);
  const [hrimsBusinessUnit, setHrimsBusinessUnit] = useState<NamedRecord | null>(null);
  const [departments, setDepartments] = useState<NamedRecord[]>([]);
  const [businessUnits, setBusinessUnits] = useState<NamedRecord[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState(user.department_id || '');
  const [selectedBuId, setSelectedBuId] = useState(user.business_unit_id || '');
  const [deptLoading, setDeptLoading] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Step 2 (AD-only users) — job title + who they report to, picked from the
  // directory. Persisted to the Circle profile and queued for HR to add to HRIMS.
  const [jobTitle, setJobTitle] = useState('');
  const [reportsTo, setReportsTo] = useState<DirectoryUser | null>(null);
  const [managerSearch, setManagerSearch] = useState('');
  const [managerResults, setManagerResults] = useState<DirectoryUser[]>([]);
  const [managerLoading, setManagerLoading] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const managerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 3 — signature
  const [signatureSaved, setSignatureSaved] = useState(hasSignature);

  // Step 4 — device
  const [deviceStatus, setDeviceStatus] = useState<'idle' | 'registering' | 'success' | 'error'>('idle');
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const webauthnSupported = typeof window !== 'undefined' && browserSupportsWebAuthn();

  // Lock body scroll while the overlay is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Look the user up in HRIMS by email (mirrors ProfileSetupModal).
  useEffect(() => {
    let cancelled = false;
    async function checkHrims() {
      if (!session?.user?.email) return;
      setHrimsLoading(true);
      try {
        const res = await fetch(`/api/hrims/employee-by-email?email=${encodeURIComponent(session.user.email)}`);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.found) {
          setHrimsFound(true);
          setHrimsEmployee(data.employee);
          setHrimsDepartment(data.department);
          setHrimsBusinessUnit(data.businessUnit);
        } else {
          setHrimsFound(false);
          // Departments are loaded per business unit (see effect below) so the
          // list stays scoped and free of the cross-unit name repetition.
          const buRes = await fetch('/api/hrims/business-units');
          if (buRes.ok) setBusinessUnits((await buRes.json()).businessUnits || []);
        }
      } catch {
        if (!cancelled) setHrimsFound(false);
      } finally {
        if (!cancelled) setHrimsLoading(false);
      }
    }
    checkHrims();
    return () => { cancelled = true; };
  }, [session?.user?.email]);

  // Load departments for the selected business unit (deduped by name). Scoping
  // to the chosen unit removes the long list of repeated department names.
  useEffect(() => {
    if (hrimsFound || !selectedBuId) {
      setDepartments([]);
      return;
    }
    let cancelled = false;
    setDeptLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/hrims/departments?business_unit_id=${encodeURIComponent(selectedBuId)}`);
        const data = res.ok ? await res.json() : { departments: [] };
        if (cancelled) return;
        const deduped = dedupeByName(data.departments || []);
        setDepartments(deduped);
        // Drop a stale department selection that isn't in the new unit's list.
        setSelectedDeptId((prev) => (deduped.some((d) => d.id === prev) ? prev : ''));
      } catch {
        if (!cancelled) setDepartments([]);
      } finally {
        if (!cancelled) setDeptLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedBuId, hrimsFound]);

  // Directory (Azure AD) search for the "who do you report to?" picker.
  useEffect(() => {
    if (managerTimer.current) clearTimeout(managerTimer.current);
    const q = managerSearch.trim();
    if (q.length < 2) { setManagerResults([]); return; }
    managerTimer.current = setTimeout(async () => {
      setManagerLoading(true);
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
        const data = res.ok ? await res.json() : { users: [] };
        setManagerResults((data.users || []).filter((u: DirectoryUser) => u.id !== user.id));
      } catch {
        setManagerResults([]);
      } finally {
        setManagerLoading(false);
      }
    }, 250);
    return () => { if (managerTimer.current) clearTimeout(managerTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerSearch]);

  const go = (next: number) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const saveProfile = async () => {
    // Nothing new to persist (already had a complete profile) — just advance.
    if (!needsProfileSetup && !hrimsFound && !(selectedBuId && selectedDeptId)) {
      go(step + 1);
      return;
    }
    setSavingProfile(true);
    setProfileError(null);
    try {
      if (hrimsFound && hrimsEmployee) {
        const res = await fetch('/api/user/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            department_id: hrimsEmployee.department_id,
            business_unit_id: hrimsEmployee.business_unit_id,
            hrims_employee_id: hrimsEmployee.id,
            job_title: hrimsEmployee.job_title,
            first_name: hrimsEmployee.first_name,
            last_name: hrimsEmployee.last_name,
          }),
        });
        if (!res.ok) throw new Error();
      } else {
        if (!selectedDeptId || !selectedBuId) {
          setProfileError('Please select your business unit and department.');
          setSavingProfile(false);
          return;
        }
        if (!jobTitle.trim()) {
          setProfileError('Please enter your job title / position.');
          setSavingProfile(false);
          return;
        }
        // AD-only user: save the Circle profile and queue the reporting line
        // for HR to add to the HRIMS organogram. The manager is RECOMMENDED but
        // optional: a new joiner's manager may not be in The Circle yet (the
        // picker only finds people who have signed in), and blocking on it used
        // to prevent the whole profile — including the department — from saving.
        const res = await fetch('/api/onboarding/reporting-line', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_unit_id: selectedBuId,
            department_id: selectedDeptId,
            job_title: jobTitle.trim(),
            reports_to_user_id: reportsTo?.id ?? null,
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d?.error);
        }
      }
      go(step + 1);
    } catch (err: any) {
      setProfileError(err?.message || 'We couldn’t save your details. Please try again.');
    } finally {
      setSavingProfile(false);
    }
  };

  const registerDevice = async () => {
    setDeviceStatus('registering');
    setDeviceError(null);
    try {
      const optsRes = await fetch('/api/webauthn/register/options', { method: 'POST' });
      if (!optsRes.ok) {
        const err = await optsRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to start registration');
      }
      const options = await optsRes.json();
      let attestationResponse;
      try {
        attestationResponse = await startRegistration({ optionsJSON: options });
      } catch (err: any) {
        // Never surface the raw WebAuthn/spec error (e.g. the timed-out /
        // not-allowed message with a w3.org link) — map it to calm copy.
        throw new Error(friendlyWebauthnError(err, 'register'));
      }
      const verifyRes = await fetch('/api/webauthn/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attestationResponse, deviceName: deviceName.trim() || undefined }),
      });
      const verifyJson = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verifyJson.error || 'Registration could not be verified.');
      setDeviceStatus('success');
      setTimeout(() => go(step + 1), 900);
    } catch (err: any) {
      setDeviceStatus('error');
      setDeviceError(err?.message || 'Something went wrong.');
    }
  };

  // The person at the top of the org (Group Chief Executive) reports to the
  // board, who are not Circle users — so we don't ask them "who do you report
  // to?". Detected from the job title they enter.
  const isTopRole = /\b(group chief executive|chief executive officer|\bceo\b|group ceo|managing director)\b/i.test(jobTitle);
  useEffect(() => {
    if (isTopRole && reportsTo) setReportsTo(null);
  }, [isTopRole, reportsTo]);

  // NOTE: the manager (reportsTo) is deliberately NOT required here — it's
  // optional in the UI and the API. Requiring it used to leave users whose
  // manager hadn't signed in yet stuck with a disabled Continue button, so
  // they abandoned onboarding and their department/business unit were never
  // saved (department_id/business_unit_id stayed NULL in app_users).
  const manualComplete = !!selectedBuId && !!selectedDeptId && !!jobTitle.trim();
  const hrimsReady = !hrimsLoading && (hrimsFound || manualComplete || !needsProfileSetup);

  // ---- per-step content ----------------------------------------------------
  const visuals = [
    <OnbImage key="v0" src="/images/welcome.svg" alt="Welcome to The Circle" />,
    <OnbImage key="v1" src="/images/RTGAtlas_Connection.svg" alt="Connecting to RTG Atlas HRIMS" />,
    <OnbImage key="v2" src="/images/Signature.svg" alt="Register your signature" />,
    <OnbImage key="v3" src="/images/Device_reg.svg" alt="Register your device" />,
    <OnbImage key="v4" src="/images/done.svg" alt="You're all set" />,
  ];

  const bodies = [
    // 0 — Welcome
    <div key="b0" className="space-y-5">
      <Eyebrow>Welcome</Eyebrow>
      <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-text-primary">
        Welcome to <span className="text-primary">The Circle</span>
      </h2>
      <p className="text-text-secondary leading-relaxed">
        The Circle is RTG’s unified approvals and workflow hub — raise requests, route them for
        sign-off, and track every decision in one secure place. Let’s take a minute to get you set up.
      </p>
      <label className="flex items-start gap-3 p-4 rounded-xl border border-border bg-primary-50/60 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-5 w-5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500 accent-primary-600"
        />
        <span className="text-sm text-text-secondary">
          I agree to The Circle’s{' '}
          <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary" onClick={(e) => e.stopPropagation()}>
            Terms of Use
          </a>{' '}
          and{' '}
          <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary" onClick={(e) => e.stopPropagation()}>
            Privacy Policy
          </a>
          , and consent to my digital signature being used to authorise approvals.
        </span>
      </label>
    </div>,

    // 1 — HRIMS
    <div key="b1" className="space-y-5">
      <Eyebrow>Step 2 · Connect</Eyebrow>
      <h2 className="text-2xl font-bold tracking-tight text-text-primary">Link your RTG Atlas (HR system) profile</h2>
      <p className="text-text-secondary leading-relaxed">
        The Circle securely connects to <span className="font-semibold text-text-primary">RTG Atlas (HRIMS)</span>{' '}
        to bring in your role, department and reporting line — so approvals route to the right people automatically.
      </p>
      {profileError && <Alert tone="danger">{profileError}</Alert>}
      {hrimsLoading ? (
        <div className="flex items-center gap-3 py-4 text-text-secondary">
          <Spinner /> Looking up your profile in RTG Atlas…
        </div>
      ) : hrimsFound && hrimsEmployee ? (
        <div className="rounded-xl border border-success-100 bg-success-50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-success-600 font-semibold text-sm">
            <CheckIcon /> Profile found in RTG Atlas
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Name" value={`${hrimsEmployee.first_name} ${hrimsEmployee.last_name}`} />
            {hrimsEmployee.job_title && <Field label="Job title" value={hrimsEmployee.job_title} />}
            <Field label="Business unit" value={hrimsBusinessUnit?.name || 'Not assigned'} />
            <Field label="Department" value={hrimsDepartment?.name || 'Not assigned'} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Alert tone="warning">
            We couldn’t match your email in RTG Atlas. Tell us where you sit and who you report to — HR will
            add you to the organogram, and approvals will route correctly in the meantime.
          </Alert>
          <Select label="Business unit" value={selectedBuId} onChange={setSelectedBuId} options={businessUnits} />
          {deptLoading ? (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Department <span className="text-danger">*</span></label>
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-neutral-300 bg-neutral-50 text-text-secondary text-sm">
                <Spinner /> Loading departments…
              </div>
            </div>
          ) : (
            <Select
              label="Department"
              value={selectedDeptId}
              onChange={setSelectedDeptId}
              options={departments}
              placeholder={!selectedBuId ? 'Select a business unit first' : undefined}
            />
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Your job title / position <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Financial Accountant"
              maxLength={120}
              className="w-full px-3 py-2.5 bg-white border border-neutral-300 rounded-lg text-text-primary focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          {!isTopRole && (
          <ManagerPicker
            selected={reportsTo}
            onSelect={(u) => { setReportsTo(u); setManagerSearch(''); setManagerResults([]); setManagerOpen(false); }}
            onClear={() => setReportsTo(null)}
            search={managerSearch}
            onSearchChange={(v) => { setManagerSearch(v); setManagerOpen(true); }}
            results={managerResults}
            loading={managerLoading}
            open={managerOpen}
            onOpen={() => setManagerOpen(true)}
          />
          )}
        </div>
      )}
    </div>,

    // 2 — Signature
    <div key="b2" className="space-y-5">
      <Eyebrow>Step 3 · Sign</Eyebrow>
      <h2 className="text-2xl font-bold tracking-tight text-text-primary">Register your signature</h2>
      <p className="text-text-secondary leading-relaxed">
        Draw, upload, or capture your signature from your phone. It’s applied to every approval you
        make and is legally binding, so please make sure it matches your official signature.
      </p>
      <SignaturePad onSave={() => setSignatureSaved(true)} />
      {signatureSaved && (
        <div className="flex items-center gap-2 text-sm text-success-600 font-medium">
          <CheckIcon /> Signature saved — you’re good to go.
        </div>
      )}
    </div>,

    // 3 — Device
    <div key="b3" className="space-y-5">
      <Eyebrow>Step 4 · Secure</Eyebrow>
      <h2 className="text-2xl font-bold tracking-tight text-text-primary">Register this device</h2>
      <p className="text-text-secondary leading-relaxed">
        Add a secure passkey by registering this device so approvals can be confirmed with a single touch. Works on
        any device.
      </p>
      {!webauthnSupported && (
        <Alert tone="warning">
          This browser can’t register a passkey. You can skip this — you’ll verify with Microsoft
          instead — or open The Circle in Chrome, Edge, or Safari to set one up.
        </Alert>
      )}
      {deviceError && <Alert tone="danger">{deviceError}</Alert>}
      {deviceStatus === 'success' ? (
        <div className="flex items-center gap-2 text-sm text-success-600 font-medium">
          <CheckIcon /> Device registered successfully.
        </div>
      ) : (
        <label className="block">
          <span className="text-xs font-medium text-text-secondary">Device name (optional)</span>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g. Work laptop"
            maxLength={60}
            disabled={deviceStatus === 'registering'}
            className="mt-1 w-full px-3 py-2.5 border border-neutral-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </label>
      )}
    </div>,

    // 4 — Ready
    <div key="b4" className="space-y-5">
      <Eyebrow>All set</Eyebrow>
      <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-text-primary">
        You’re ready to go
      </h2>
      <p className="text-text-secondary leading-relaxed">
        Your profile is linked, your signature is registered and your device is secured. Everything’s
        in place — welcome to a faster, clearer way to get approvals done.
      </p>
      <ul className="space-y-2.5">
        {['HRIMS profile connected', 'Digital signature registered', 'Account secured'].map((t) => (
          <li key={t} className="flex items-center gap-3 text-sm text-text-primary">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success-100 text-success-600">
              <CheckIcon />
            </span>
            {t}
          </li>
        ))}
      </ul>
    </div>,
  ];

  // ---- footer action ------------------------------------------------------
  const primary = useMemo(() => {
    switch (step) {
      case 0:
        return { label: 'Get started', disabled: !consent, onClick: () => go(1), loading: false };
      case 1:
        return { label: 'Continue', disabled: !hrimsReady || savingProfile, onClick: saveProfile, loading: savingProfile };
      case 2:
        return { label: 'Continue', disabled: !signatureSaved, onClick: () => go(3), loading: false };
      case 3:
        if (deviceStatus === 'success' || !webauthnSupported)
          return { label: 'Continue', disabled: false, onClick: () => go(4), loading: false };
        return { label: 'Register device', disabled: deviceStatus === 'registering', onClick: registerDevice, loading: deviceStatus === 'registering' };
      default:
        return { label: 'Enter The Circle', disabled: false, onClick: onComplete, loading: false };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, consent, hrimsReady, savingProfile, signatureSaved, deviceStatus, webauthnSupported,
      hrimsFound, selectedBuId, selectedDeptId, jobTitle, reportsTo, deviceName]);

  const showBack = step > 0 && step < 4;
  const showSkip = step === 3 && deviceStatus !== 'success' && deviceStatus !== 'registering';

  const overlay = (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-4 bg-neutral-900/50 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="relative w-full max-w-4xl h-[640px] max-h-[94vh] bg-surface rounded-3xl shadow-2xl ring-1 ring-black/5 flex flex-col overflow-hidden"
      >
        {/* Stage — visual + body slide together */}
        <div className="relative flex-1 overflow-hidden">
          <AnimatePresence custom={dir} initial={false} mode="popLayout">
            <motion.div
              key={step}
              custom={dir}
              variants={slide}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
              className="absolute inset-0 grid grid-cols-1 md:grid-cols-2"
            >
              {/* Visual panel */}
              <div className="relative hidden md:flex items-center justify-center overflow-hidden bg-gradient-to-br from-primary-50 via-surface to-accent-500/10 p-10">
                <div className="pointer-events-none absolute -top-16 -left-16 h-56 w-56 rounded-full bg-primary-200/40 blur-2xl" />
                <div className="pointer-events-none absolute -bottom-20 -right-10 h-56 w-56 rounded-full bg-accent-500/20 blur-2xl" />
                <div className="relative w-full max-w-[320px]">{visuals[step]}</div>
              </div>
              {/* Body */}
              <div className="flex flex-col overflow-y-auto p-7 sm:p-9">
                {/* Compact visual for mobile */}
                <div className="md:hidden mb-5 flex items-center justify-center">
                  <div className="w-40">{visuals[step]}</div>
                </div>
                {bodies[step]}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer — pagination + actions (static) */}
        <div className="flex items-center justify-between gap-4 border-t border-border px-7 sm:px-9 py-4 bg-neutral-50/60">
          <Dots total={STEPS.length} active={step} />
          <div className="flex items-center gap-2">
            {showSkip && (
              <button
                onClick={() => go(4)}
                className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Skip for now
              </button>
            )}
            {showBack && (
              <button
                onClick={() => go(step - 1)}
                className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={primary.onClick}
              disabled={primary.disabled}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {primary.loading && <Spinner light />}
              {primary.label}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );

  if (typeof window === 'undefined') return null;
  return createPortal(overlay, document.body);
}

/* ---------- small presentational helpers ---------- */

function OnbImage({ src, alt }: { src: string; alt: string }) {
  return (
    <motion.img
      src={src}
      alt={alt}
      draggable={false}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="w-full h-auto max-h-[340px] object-contain select-none"
    />
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-xs font-semibold uppercase tracking-wider text-primary-500">
      {children}
    </span>
  );
}

function Dots({ total, active }: { total: number; active: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <motion.span
          key={i}
          animate={{
            width: i === active ? 26 : 8,
            backgroundColor: i === active ? '#9A7545' : i < active ? '#C9A574' : '#DAD7CF',
          }}
          transition={{ duration: 0.3 }}
          className="h-2 rounded-full"
        />
      ))}
    </div>
  );
}

function Spinner({ light }: { light?: boolean }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 ${
        light ? 'border-white/40 border-t-white' : 'border-primary-200 border-t-primary-600'
      }`}
    />
  );
}

function CheckIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-text-muted mb-0.5">{label}</div>
      <div className="text-sm font-medium text-text-primary">{value}</div>
    </div>
  );
}

function Alert({ tone, children }: { tone: 'warning' | 'danger'; children: React.ReactNode }) {
  const styles =
    tone === 'danger'
      ? 'bg-danger-50 border-danger-100 text-danger-600'
      : 'bg-warning-50 border-warning-100 text-warning-600';
  return <div className={`rounded-xl border p-3 text-sm ${styles}`}>{children}</div>;
}

function Select({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: NamedRecord[];
  placeholder?: string;
}) {
  const emptyLabel = placeholder || `No ${label.toLowerCase()}s available`;
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1.5">
        {label} <span className="text-danger">*</span>
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options.length === 0}
        className="w-full px-3 py-2.5 bg-white border border-neutral-300 rounded-lg text-text-primary focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-neutral-100 disabled:text-text-muted"
      >
        <option value="">{options.length === 0 ? emptyLabel : `Select ${label.toLowerCase()}…`}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
  );
}

function ManagerPicker({
  selected,
  onSelect,
  onClear,
  search,
  onSearchChange,
  results,
  loading,
  open,
  onOpen,
}: {
  selected: DirectoryUser | null;
  onSelect: (u: DirectoryUser) => void;
  onClear: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  results: DirectoryUser[];
  loading: boolean;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1.5">
        Who do you report to? <span className="text-text-muted font-normal">(optional)</span>
      </label>
      <p className="text-xs text-text-muted mb-1.5">
        If you can’t find your manager yet (they may not have signed in), you can leave this and set it later.
      </p>
      {selected ? (
        <div className="flex items-center gap-3 bg-primary-50 border border-primary-200 p-3 rounded-lg">
          <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
            <span className="text-sm font-medium text-primary-600">{(selected.display_name || selected.email)?.charAt(0)?.toUpperCase() || '?'}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{selected.display_name || selected.email}</p>
            {selected.job_title ? <p className="text-xs text-text-muted truncate">{selected.job_title}</p> : <p className="text-xs text-text-muted truncate">{selected.email}</p>}
          </div>
          <button type="button" onClick={onClear} className="p-1.5 rounded-lg text-text-muted hover:text-danger-500 hover:bg-danger-50 transition-colors" title="Change">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      ) : (
        <div>
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onFocus={onOpen}
            placeholder="Search your manager’s name…"
            className="w-full px-3 py-2.5 bg-white border border-neutral-300 rounded-lg text-text-primary focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          {open && (search.trim().length >= 1 || loading) && (
            <div className="mt-1 w-full bg-white border border-neutral-200 rounded-lg shadow-sm max-h-56 overflow-y-auto overscroll-contain">
              {loading ? (
                <div className="flex items-center gap-2 p-3 text-sm text-text-secondary"><Spinner /> Searching the directory…</div>
              ) : search.trim().length < 2 ? (
                <div className="p-3 text-sm text-text-muted">Keep typing to search…</div>
              ) : results.length === 0 ? (
                <div className="p-3 text-sm text-text-muted">No matching people found.</div>
              ) : (
                results.slice(0, 10).map((u) => (
                  <button key={u.id} type="button" onClick={() => onSelect(u)} className="w-full flex items-center gap-3 p-3 hover:bg-neutral-50 transition-colors text-left">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center flex-shrink-0"><span className="text-sm font-medium text-text-secondary">{(u.display_name || u.email)?.charAt(0)?.toUpperCase() || '?'}</span></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{u.display_name || u.email}</p>
                      <p className="text-xs text-text-muted truncate">{u.job_title || u.email}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

