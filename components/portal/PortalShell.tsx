import { ReactNode, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import PortalBrand from './PortalBrand';
import { LogOut } from 'lucide-react';

/**
 * Chrome for the authenticated Director Portal. Independent of AppLayout since
 * directors are not app users. Provides the brand header and a sign-out control.
 */
export default function PortalShell({ title, directorName, children }: { title: string; directorName?: string; children: ReactNode }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try { await fetch('/api/portal/logout', { method: 'POST' }); } catch { /* ignore */ }
    router.replace('/board-portal/login');
  };

  return (
    <>
      <Head><title>{title} · Board Portal</title></Head>
      <div className="min-h-screen bg-neutral-50">
        <header className="bg-white border-b border-neutral-200 sticky top-0 z-10">
          <div className="max-w-3xl mx-auto flex items-center justify-between px-4 sm:px-6 py-3">
            <PortalBrand />
            <div className="flex items-center gap-3">
              {directorName && <span className="hidden sm:inline text-sm text-neutral-500">{directorName}</span>}
              <button onClick={signOut} disabled={signingOut}
                className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-800 disabled:opacity-50">
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </div>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">{children}</main>
      </div>
    </>
  );
}
