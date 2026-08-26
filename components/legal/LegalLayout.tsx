import Head from 'next/head';
import Link from 'next/link';
import { ReactNode } from 'react';

/**
 * Shared chrome for the standalone legal documents (Terms of Use, Privacy
 * Policy). Kept independent of AppLayout so the pages open cleanly in a new
 * tab from the onboarding consent step without requiring the app shell.
 */
export default function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <>
      <Head>
        <title>{title} · The Circle</title>
      </Head>
      <div className="min-h-screen bg-background text-text-primary font-sans">
        {/* Brand header */}
        <header className="border-b border-border bg-white/80 backdrop-blur-md">
          <div className="max-w-3xl mx-auto flex items-center gap-3 px-6 py-4">
            <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="legalBrandGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#9A7545" />
                  <stop offset="100%" stopColor="#C9A574" />
                </linearGradient>
              </defs>
              <path
                d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z"
                fill="url(#legalBrandGradient)"
              />
            </svg>
            <span className="font-bold text-lg tracking-tight">The Circle</span>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Rainbow Tourism Group</p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-bold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-text-secondary">Last updated {updated}</p>

          <div className="legal-prose mt-8 space-y-6 text-[15px] leading-relaxed text-neutral-700">
            {children}
          </div>

          <div className="mt-12 border-t border-border pt-6">
            <Link href="/dashboard" className="text-sm font-medium text-primary hover:text-primary-hover">
              ← Back to The Circle
            </Link>
          </div>
        </main>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .legal-prose h2 {
          font-size: 1.125rem;
          font-weight: 700;
          color: #1a1813;
          margin-top: 1.75rem;
          margin-bottom: 0.5rem;
        }
        .legal-prose p { margin-bottom: 0.5rem; }
        .legal-prose ul { list-style: disc; padding-left: 1.25rem; margin: 0.25rem 0 0.75rem; }
        .legal-prose li { margin-bottom: 0.35rem; }
        .legal-prose strong { color: #33312c; font-weight: 600; }
      ` }} />
    </>
  );
}
