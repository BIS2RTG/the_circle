/** @type {import('next').NextConfig} */

// Neutralize blank (empty-string) URL env vars before anything else loads, so a
// misconfigured Vercel var (e.g. NEXTAUTH_URL / NEXTAUTH_URL_INTERNAL) can't crash
// `next build` with `TypeError: Invalid URL, input: ''`. See the script header.
require('./scripts/build-url-guard');

const isProd = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Content-Security-Policy
//
// Tuned to this stack:
//   - 'unsafe-inline' (script) — Next.js Pages Router injects inline bootstrap
//     scripts; 'unsafe-eval' — required by the dev/webpack runtime and pdf.js.
//   - 'unsafe-inline' (style) + fonts.googleapis.com — styled-components inject
//     inline styles, and globals.css @imports the Manrope font stylesheet.
//   - *.supabase.co (https + wss) — client SDK REST calls and realtime sockets.
//   - blob:/data: — generated PDFs, signature canvases, and the pdf.js worker.
//   - ui-avatars.com — generated initials avatars used as the fallback when a
//     user has no uploaded profile picture (img-src only).
// frame-ancestors 'none' blocks clickjacking (X-Frame-Options is kept as the
// legacy fallback). upgrade-insecure-requests is prod-only so local http dev
// is unaffected.
// ---------------------------------------------------------------------------
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://*.supabase.co https://graph.microsoft.com https://ui-avatars.com",
  // blob:/data: — the e-sign PDF editor fetches the user-uploaded PDF from an
  // in-memory blob: URL, and pdf.js reads data: URLs; without these the
  // document fails to load under CSP.
  "connect-src 'self' blob: data: https://*.supabase.co wss://*.supabase.co https://graph.microsoft.com",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

const securityHeaders = [
  // Force HTTPS for two years incl. subdomains (prod only — never send over
  // plain-http local dev where it would be cached against localhost).
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  // Disable powerful features the app never uses (WebAuthn / publickey-
  // credentials are intentionally left at their default 'self' allowance).
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // drop the X-Powered-By: Next.js fingerprint
  // Ensure the RTG logo file is bundled into the PDF-generating serverless
  // functions on Vercel (fs.readFileSync at runtime needs it traced in).
  outputFileTracingIncludes: {
    '/api/archives/**': ['./public/images/RTG_LOGO.png', './images/RTG_LOGO.png'],
    '/api/requests/**': ['./public/images/RTG_LOGO.png', './images/RTG_LOGO.png'],
  },
  images: {
    domains: [
      'kidreqxqapouxndqomdp.supabase.co', // staging Supabase storage
      'rdrdsqkgbpfeixbzwmxb.supabase.co', // production Supabase storage
    ],
  },
  async headers() {
    return [
      {
        // Apply the security headers to every route.
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  async redirects() {
    return [
      {
        // The standalone History & Archives page was merged into My Requests
        // (Requests + Archived Documents tabs). Keep old bookmarks working;
        // any ?tab= query is forwarded automatically.
        source: '/requests/history',
        destination: '/requests/my-requests',
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
