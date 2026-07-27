import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]';
import { signatureExists, userSignaturePath, userSignatureProxyUrl } from '@/lib/signatureStorage';
import { AppLayout } from '@/components/layout';
import { Card, Button } from '@/components/ui';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUserHrimsProfile } from '@/hooks/useUserHrimsProfile';
import dynamic from 'next/dynamic';
import BiometricSetupModal from '@/components/approvals/BiometricSetupModal';
import {
  Pencil,
  SlidersHorizontal,
  Bell,
  ShieldCheck,
  PenLine,
  Fingerprint,
  Check,
  CloudUpload,
} from 'lucide-react';

const SignaturePad = dynamic(() => import('@/components/SignaturePad'), {
  ssr: false,
  loading: () => <div className="h-40 bg-neutral-100 animate-pulse rounded-xl" />,
});

interface SettingsProps {
  initialSignatureUrl: string | null;
}

/** Server-side preferences (user_preferences table) — drive real behaviour:
 *  which emails the workflow engine sends and whether approved PDFs are
 *  auto-saved to the user's OneDrive. */
type ReminderChannel = 'email' | 'in_app' | 'both' | 'none';
type ReminderFrequency = 'daily' | 'every_2_days' | 'weekly' | 'off';

interface ServerPreferences {
  emailRequestUpdates: boolean;
  emailApprovalTasks: boolean;
  emailCompletionPdf: boolean;
  approvalReminders: boolean;
  reminderChannel: ReminderChannel;
  reminderFrequency: ReminderFrequency;
  draftReminders: boolean;
  weeklyDigest: boolean;
  autoArchiveOneDrive: boolean;
  oneDriveFolder: string | null;
  landingPage: string | null;
}

interface IntegrationStatus {
  emailConfigured: boolean;
  onedriveConfigured: boolean;
  sharepointConfigured: boolean;
}

const DEFAULT_SERVER_PREFS: ServerPreferences = {
  emailRequestUpdates: true,
  emailApprovalTasks: true,
  emailCompletionPdf: true,
  approvalReminders: true,
  reminderChannel: 'both',
  reminderFrequency: 'daily',
  draftReminders: true,
  weeklyDigest: false,
  autoArchiveOneDrive: true,
  oneDriveFolder: null,
  landingPage: null,
};

const LANDING_PAGE_OPTIONS: { value: string; label: string }[] = [
  { value: '/dashboard', label: 'Dashboard' },
  { value: '/requests/my-requests', label: 'Track Requests' },
  { value: '/requests/drafts', label: 'My Drafts' },
  { value: '/approvals', label: 'My Approval Tasks' },
  { value: '/notifications', label: 'Notifications' },
];

export const getServerSideProps: GetServerSideProps<SettingsProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user) {
    return { redirect: { destination: '/', permanent: false } };
  }

  const user = session.user as any;
  const userId = user.id;
  let initialSignatureUrl: string | null = null;

  try {
    if (userId && (await signatureExists(userSignaturePath(userId)))) {
      // Private bucket: render through the authenticated proxy. Cache-bust so a
      // just-replaced signature never renders from the browser's image cache.
      initialSignatureUrl = `${userSignatureProxyUrl(userId)}&t=${Date.now()}`;
    }
  } catch (e) {
    // No signature found
  }

  return { props: { initialSignatureUrl } };
};

// ---- Small building blocks ----

function SectionCard({ icon: Icon, title, subtitle, children }: { icon: any; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3 mb-5">
        <span className="text-neutral-700 mt-0.5">
          <Icon className="w-5 h-5" strokeWidth={1.5} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          {subtitle && <p className="text-sm text-text-secondary mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <>{children}</>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const selectCls =
  'w-full h-11 px-3.5 bg-white border border-border rounded-xl text-sm text-text-primary focus:border-primary-300 focus:ring-2 focus:ring-primary-100 outline-none transition-all';

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {description && <p className="text-xs text-text-secondary mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-primary-500' : 'bg-neutral-300'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <span className="text-sm text-text-primary font-medium text-right truncate capitalize">{value}</span>
    </div>
  );
}

export default function Settings({ initialSignatureUrl }: SettingsProps) {
  const { user, session, updateProfilePicture } = useCurrentUser();
  const { departmentName, businessUnitName, jobTitle: hrimsJobTitle } = useUserHrimsProfile();

  const [signatureUrl, setSignatureUrl] = useState<string | null>(initialSignatureUrl);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [serverPrefs, setServerPrefs] = useState<ServerPreferences>(DEFAULT_SERVER_PREFS);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);

  const [biometricCredentials, setBiometricCredentials] = useState<any[]>([]);
  const [loadingBiometrics, setLoadingBiometrics] = useState(false);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);

  // Load notification/auto-archiving preferences (stored server-side so the
  // workflow engine can honour them when sending emails and syncing PDFs).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/user/preferences');
        if (!res.ok) return;
        const data = await res.json();
        if (data.preferences) setServerPrefs({ ...DEFAULT_SERVER_PREFS, ...data.preferences });
        if (data.integration) setIntegration(data.integration);
      } catch (err) {
        console.error('Failed to load preferences:', err);
      }
    })();
  }, []);

  const setServerPref = <K extends keyof ServerPreferences>(key: K, value: ServerPreferences[K]) => {
    setServerPrefs((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  // Load profile picture from the user's stored URL (set on upload and on MS
  // login). No storage probing — if there's no URL, there's no picture.
  useEffect(() => {
    if (user?.id && user.profile_picture_url) {
      const url = user.profile_picture_url;
      setProfilePhoto(url.includes('?') ? url : `${url}?t=${Date.now()}`);
    }
  }, [user]);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please select an image file'); return; }
    if (file.size > 4 * 1024 * 1024) { alert('Image size must be less than 4MB'); return; }

    setUploadingPicture(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      try {
        const res = await fetch('/api/user/profile-picture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64 }),
        });
        const data = await res.json();
        if (data.url) {
          const urlWithCache = `${data.url}?t=${Date.now()}`;
          setProfilePhoto(urlWithCache);
          updateProfilePicture(urlWithCache);
        } else {
          alert('Failed to upload profile picture');
        }
      } catch (err) {
        console.error('Upload error', err);
        alert('Failed to upload profile picture');
      } finally {
        setUploadingPicture(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverPrefs),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save preferences');
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  const fetchBiometricCredentials = async () => {
    setLoadingBiometrics(true);
    try {
      const res = await fetch('/api/webauthn/credentials');
      if (res.ok) {
        const data = await res.json();
        setBiometricCredentials(data.credentials || []);
      }
    } catch (err) {
      console.error('Failed to load biometric credentials:', err);
    } finally {
      setLoadingBiometrics(false);
    }
  };

  useEffect(() => { fetchBiometricCredentials(); }, []);

  const handleDeleteCredential = async (id: string) => {
    if (!confirm('Remove this device? You will need to re-register it to use biometric verification.')) return;
    try {
      const res = await fetch(`/api/webauthn/credentials/${id}`, { method: 'DELETE' });
      if (res.ok) setBiometricCredentials((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.error('Failed to delete credential:', err);
    }
  };

  const displayName = user?.display_name || session?.user?.name || 'User';
  const email = user?.email || session?.user?.email || '—';

  return (
    <>
      <Head>
        <title>My Settings - The Circle</title>
      </Head>

      <AppLayout title="My Settings">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-6 max-w-6xl mx-auto">
          {/* Page header with save action */}
          <div className="flex items-center justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">My Settings</h1>
              <p className="text-text-secondary mt-1.5 text-sm sm:text-base">
                Configure how the system works for you. Personal details are managed in HRIMS.
              </p>
            </div>
            <Button variant="primary" onClick={handleSave} disabled={saving} className="shrink-0 flex items-center gap-2">
              {saved ? <Check className="w-4 h-4" strokeWidth={2} /> : null}
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save Changes'}
            </Button>
          </div>

          {saveError && (
            <div className="mb-6 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
              {saveError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: configurable preferences */}
            <div className="lg:col-span-2 space-y-6">
              <SectionCard icon={SlidersHorizontal} title="Preferences" subtitle="Tune the defaults to suit how you work.">
                <Field label="Default landing page">
                  <select className={selectCls} value={serverPrefs.landingPage || '/dashboard'} onChange={(e) => setServerPref('landingPage', e.target.value)}>
                    {LANDING_PAGE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-text-secondary mt-1.5">The page The Circle opens for you after you sign in.</p>
                </Field>
              </SectionCard>

              <SectionCard icon={Bell} title="Reminders" subtitle="How and how often The Circle nudges you about work that&apos;s waiting.">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <Field label="Send reminders via">
                    <select className={selectCls} value={serverPrefs.reminderChannel} onChange={(e) => setServerPref('reminderChannel', e.target.value as ReminderChannel)}>
                      <option value="both">Email &amp; in-app</option>
                      <option value="email">Email only</option>
                      <option value="in_app">In-app only</option>
                      <option value="none">Don&apos;t remind me</option>
                    </select>
                  </Field>
                  <Field label="How often">
                    <select
                      className={selectCls}
                      value={serverPrefs.reminderFrequency}
                      disabled={serverPrefs.reminderChannel === 'none'}
                      onChange={(e) => setServerPref('reminderFrequency', e.target.value as ReminderFrequency)}
                    >
                      <option value="daily">Daily</option>
                      <option value="every_2_days">Every 2 days</option>
                      <option value="weekly">Weekly</option>
                      <option value="off">Off</option>
                    </select>
                  </Field>
                </div>
                <div className="mt-2 divide-y divide-border">
                  <Toggle
                    checked={serverPrefs.draftReminders}
                    onChange={(v) => setServerPref('draftReminders', v)}
                    label="Remind me about my drafts"
                    description="Nudge me about my own requests that are still unsubmitted after a while."
                  />
                </div>
                <p className="text-xs text-text-secondary mt-3">
                  Reminders cover approval tasks waiting on you and, if enabled above, your stale drafts. Administrators set the standard
                  timing (how long before the first reminder) under Admin → SLAs.
                </p>
              </SectionCard>

              <SectionCard icon={Bell} title="Email notifications" subtitle="Choose which other emails The Circle sends you. In-app notifications are always on.">
                {integration && !integration.emailConfigured && (
                  <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3.5 py-2.5 text-xs">
                    Email delivery is not configured for this deployment yet — ask an administrator to set up the
                    Microsoft 365 service mailbox (GRAPH_MAIL_SENDER) or Resend. Your choices below are saved and take
                    effect as soon as email is enabled.
                  </div>
                )}
                <div className="divide-y divide-border">
                  <Toggle
                    checked={serverPrefs.emailRequestUpdates}
                    onChange={(v) => setServerPref('emailRequestUpdates', v)}
                    label="Review updates on my requests"
                    description="Email me when my request is approved or rejected at each review step."
                  />
                  <Toggle
                    checked={serverPrefs.emailCompletionPdf}
                    onChange={(v) => setServerPref('emailCompletionPdf', v)}
                    label="Completed request with signed PDF"
                    description="When my request is fully approved, email me the signed approval document."
                  />
                  <Toggle
                    checked={serverPrefs.emailApprovalTasks}
                    onChange={(v) => setServerPref('emailApprovalTasks', v)}
                    label="New approval tasks"
                    description="Email me when a request is waiting on my approval."
                  />
                  <Toggle
                    checked={serverPrefs.weeklyDigest}
                    onChange={(v) => setServerPref('weeklyDigest', v)}
                    label="Weekly summary digest"
                    description="A weekly recap of your requests and approvals."
                  />
                </div>
              </SectionCard>

              <SectionCard icon={CloudUpload} title="Auto-archiving" subtitle="Where your approved documents are saved automatically.">
                {integration && !integration.onedriveConfigured && (
                  <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3.5 py-2.5 text-xs">
                    OneDrive auto-archiving is not configured for this deployment yet — ask an administrator to enable
                    the Microsoft 365 integration (GRAPH_ONEDRIVE_ENABLED). Your choices below are saved and take effect
                    as soon as it is enabled.
                  </div>
                )}
                <div className="divide-y divide-border">
                  <Toggle
                    checked={serverPrefs.autoArchiveOneDrive}
                    onChange={(v) => setServerPref('autoArchiveOneDrive', v)}
                    label="Save approved PDFs to my OneDrive"
                    description="When a request completes review, automatically save the signed PDF into your OneDrive and link it on the request."
                  />
                  {serverPrefs.autoArchiveOneDrive && (
                    <div className="py-3">
                      <Field label="OneDrive folder">
                        <input
                          type="text"
                          className={selectCls}
                          placeholder="The Circle Approvals"
                          value={serverPrefs.oneDriveFolder || ''}
                          onChange={(e) => setServerPref('oneDriveFolder', e.target.value || null)}
                        />
                      </Field>
                      <p className="text-xs text-text-secondary mt-1.5">
                        Folder in your OneDrive where approved documents are filed. Leave blank for the default.
                      </p>
                    </div>
                  )}
                </div>
                <div className="mt-4 rounded-xl bg-neutral-50 border border-border px-3.5 py-3 text-xs text-text-secondary">
                  Approved documents are always kept in The Circle&apos;s archive
                  {integration?.sharepointConfigured ? ' and the organisation’s SharePoint library' : ''}, so you can
                  download them from the request page at any time.
                </div>
              </SectionCard>

              <SectionCard icon={PenLine} title="Digital signature" subtitle="Used to authorise your requests and approvals.">
                <SignaturePad initialUrl={signatureUrl || undefined} onSave={(url) => setSignatureUrl(url)} />
              </SectionCard>

              <SectionCard icon={ShieldCheck} title="Security" subtitle="Manage biometric verification for high-risk approvals.">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm text-text-secondary">Use Windows Hello, Touch ID, or Face ID to verify sensitive approvals.</p>
                  <Button variant="outline" onClick={() => setShowBiometricSetup(true)} className="shrink-0">Register device</Button>
                </div>

                {loadingBiometrics ? (
                  <div className="text-sm text-text-secondary py-4 text-center">Loading devices…</div>
                ) : biometricCredentials.length === 0 ? (
                  <div className="p-4 bg-neutral-50 rounded-xl border border-border text-center">
                    <p className="text-sm text-text-secondary">No biometric devices registered yet.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {biometricCredentials.map((cred: any) => (
                      <div key={cred.id} className="flex items-center justify-between p-4 bg-neutral-50 rounded-xl border border-border">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-neutral-700 shrink-0">
                            <Fingerprint className="w-5 h-5" strokeWidth={1.5} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">
                              {cred.device_name || 'Biometric Device'}
                              {cred.usable_here === false && (
                                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 align-middle">
                                  Different environment
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-text-secondary">
                              Added {new Date(cred.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                              {cred.last_used_at ? ` • Last used ${new Date(cred.last_used_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : ''}
                              {cred.usable_here === false && cred.rp_id ? ` • Registered on ${cred.rp_id}` : ''}
                            </p>
                          </div>
                        </div>
                        <button onClick={() => handleDeleteCredential(cred.id)} className="text-sm text-danger hover:text-danger-600 font-medium shrink-0">
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>

            {/* Right: profile photo + HRIMS identity (read-only) */}
            <div className="space-y-6">
              <Card className="p-6">
                <h2 className="text-base font-semibold text-text-primary mb-5">Profile photo</h2>
                <div className="flex flex-col items-center text-center">
                  <div className="relative">
                    <div className="w-28 h-28 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500 text-3xl font-bold overflow-hidden ring-1 ring-border">
                      {profilePhoto ? (
                        <img src={profilePhoto} alt="Profile" className="w-full h-full object-cover" />
                      ) : (
                        <span>{displayName.charAt(0)}</span>
                      )}
                    </div>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingPicture}
                      className="absolute bottom-0 right-0 bg-primary-500 text-white rounded-full p-2 shadow-sm hover:bg-primary-600 transition-colors"
                      aria-label="Change photo"
                    >
                      {uploadingPicture ? (
                        <div className="w-4 h-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      ) : (
                        <Pencil className="w-4 h-4" strokeWidth={1.5} />
                      )}
                    </button>
                    <input ref={fileInputRef} type="file" className="hidden" accept="image/*" onChange={handlePhotoUpload} />
                  </div>
                  <p className="mt-4 font-semibold text-text-primary">{displayName}</p>
                  <p className="text-sm text-text-secondary">{email}</p>
                  <p className="mt-1 text-xs text-text-muted">{uploadingPicture ? 'Uploading…' : 'JPG or PNG, up to 4MB'}</p>
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-base font-semibold text-text-primary">Identity</h2>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted bg-neutral-100 px-2 py-0.5 rounded-full">From HRIMS</span>
                </div>
                <div className="space-y-0">
                  <ReadOnlyRow label="Full name" value={displayName} />
                  <ReadOnlyRow label="Job title" value={hrimsJobTitle || user?.job_title || 'User'} />
                  <ReadOnlyRow label="Department" value={departmentName || 'Not assigned'} />
                  <ReadOnlyRow label="Business unit" value={businessUnitName || 'Not assigned'} />
                  <ReadOnlyRow label="Email" value={email} />
                </div>
                <p className="mt-3 text-xs text-text-muted">Personal details are sourced from HRIMS and can&apos;t be edited here.</p>
              </Card>
            </div>
          </div>
        </div>

        <BiometricSetupModal
          isOpen={showBiometricSetup}
          onClose={() => setShowBiometricSetup(false)}
          onSuccess={() => {
            setShowBiometricSetup(false);
            fetchBiometricCredentials();
          }}
        />
      </AppLayout>
    </>
  );
}
