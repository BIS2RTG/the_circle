/**
 * Environment detection (client-safe).
 *
 * Production is the ONLY deployment that runs against the production Supabase
 * project. Every other environment — staging, the legal deployment, Vercel
 * previews, and local dev — points at a different Supabase URL, so we treat all
 * of them as "staging". This is used to gate staging-only affordances (e.g. the
 * dismissible onboarding wizard) without ever loosening them in production.
 */

/** The production Supabase project ref. Any other project ⇒ non-production. */
const PROD_SUPABASE_REF = 'rdrdsqkgbpfeixbzwmxb';

export function isStagingEnvironment(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  return !url.includes(PROD_SUPABASE_REF);
}
