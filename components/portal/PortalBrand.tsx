/**
 * Shared brand mark for the Director Portal and secure-link pages. Kept
 * independent of the app shell (AppLayout) since directors are not app users.
 */
export default function PortalBrand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="portalBrand" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#9A7545" /><stop offset="100%" stopColor="#C9A574" />
          </linearGradient>
        </defs>
        <path d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z" fill="url(#portalBrand)" />
      </svg>
      <div className="leading-tight">
        <span className="block font-bold text-[15px] tracking-tight text-neutral-900">The Circle</span>
        <span className="block text-[11px] text-neutral-400">{subtitle || 'Board Portal'}</span>
      </div>
    </div>
  );
}
