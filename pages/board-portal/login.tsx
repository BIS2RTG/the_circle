import { useState } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import PortalBrand from '../../components/portal/PortalBrand';
import { getDirectorSessionSSR } from '@/lib/directorSession';
import { Mail, CheckCircle2, ArrowRight } from 'lucide-react';

/**
 * Director Portal sign-in. The director enters their email and receives a
 * single-use magic link (no password). Response is always generic so the page
 * cannot be used to discover which emails belong to directors.
 */
export default function PortalLogin() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch('/api/portal/login-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      setMessage(d.message || 'If that email is on file, a secure sign-in link is on its way.');
      setSent(true);
    } catch { setMessage('If that email is on file, a secure sign-in link is on its way.'); setSent(true); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Head><title>Board Portal · Sign in</title></Head>
      <div className="min-h-screen bg-neutral-50 flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-center"><PortalBrand subtitle="Director Portal" /></div>

          <div className="bg-white rounded-2xl border border-neutral-200 p-6 sm:p-8">
            {sent ? (
              <div className="text-center">
                <div className="w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                </div>
                <h1 className="text-lg font-bold text-neutral-900">Check your email</h1>
                <p className="text-sm text-neutral-500 mt-2">{message}</p>
                <p className="text-xs text-neutral-400 mt-4">The link is single-use and expires shortly. Didn&apos;t get it?{' '}
                  <button onClick={() => { setSent(false); setMessage(''); }} className="text-primary-600 font-medium hover:underline">Try again</button>.
                </p>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-bold text-neutral-900">Sign in to the Board Portal</h1>
                <p className="text-sm text-neutral-500 mt-1.5">Enter the email address on file with the Company Secretary. We&apos;ll send you a secure sign-in link — no password needed.</p>
                <form onSubmit={submit} className="mt-6 space-y-3">
                  <div className="relative">
                    <Mail className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                      className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  </div>
                  <button type="submit" disabled={busy}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-primary-600 text-white font-semibold disabled:opacity-50 hover:bg-primary-700 transition-colors">
                    {busy ? 'Sending…' : <>Send me a sign-in link <ArrowRight className="w-4 h-4" /></>}
                  </button>
                </form>
              </>
            )}
          </div>
          <p className="text-center text-xs text-neutral-400 mt-5">Rainbow Tourism Group · Board Governance</p>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getDirectorSessionSSR(ctx);
  if (session) return { redirect: { destination: '/board-portal', permanent: false } };
  return { props: {} };
};
