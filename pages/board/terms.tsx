import Head from 'next/head';

/**
 * PUBLIC terms for EXTERNAL board members (people who do not hold an RTG staff
 * account) who sign for board / committee attendance via a personal email link.
 * Focused on electronic-signature consent, and the use, storage and legal
 * compliance of their digital signature. Linked from /board/attend/[token].
 */
export default function BoardSignatureTerms() {
  const updated = 'August 2026';
  return (
    <>
      <Head><title>Board e-Signature Terms · The Circle</title></Head>
      <div className="min-h-screen bg-neutral-50 flex flex-col items-center px-4 py-8">
        <div className="w-full max-w-2xl">
          <div className="flex items-center gap-2 mb-6">
            <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs><linearGradient id="tg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#9A7545" /><stop offset="100%" stopColor="#C9A574" /></linearGradient></defs>
              <path d="M 100 25 C 145 25, 180 60, 180 100 C 180 145, 145 180, 100 180 C 55 180, 20 145, 20 100 C 20 60, 52 28, 95 25 L 100 25 L 98 40 C 60 42, 35 65, 35 100 C 35 138, 65 167, 100 167 C 138 167, 167 138, 167 100 C 167 65, 140 38, 100 38 Z" fill="url(#tg)" />
            </svg>
            <span className="font-bold text-lg tracking-tight">The Circle</span>
          </div>

          <div className="bg-white rounded-2xl border border-neutral-200 p-6 sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">Rainbow Tourism Group · Board Governance</p>
            <h1 className="mt-1 text-2xl font-bold text-neutral-900">Electronic Signature Terms for Board Members</h1>
            <p className="text-sm text-neutral-500 mt-1">For external board and committee members · Last updated {updated}</p>

            <div className="mt-6 space-y-6 text-sm leading-relaxed text-neutral-700">
              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">1. Who these terms are for</h2>
                <p>These terms apply to you as an external member of a Rainbow Tourism Group (&ldquo;RTG&rdquo;) board or committee who does not hold an RTG staff account. They govern your use of the personal link we email you to sign for your attendance and to acknowledge governance records electronically.</p>
              </section>

              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">2. Consent to sign electronically</h2>
                <p>You agree that drawing your signature on this platform is your electronic signature, that you intend it to sign and authenticate the record it is applied to, and that it has the same legal effect as a handwritten signature. You confirm you are the person named on the link and that you are signing of your own accord.</p>
              </section>

              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">3. What you are acknowledging</h2>
                <p>Your signature confirms the attendance record shown to you — for example that you were recorded as <em>present</em>, or that you tendered an <em>apology</em> or were <em>absent</em>. Signing does not by itself assert that you attended; it confirms the specific status presented to you. If that status is wrong, do not sign — reply to the legal team so it can be corrected first.</p>
              </section>

              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">4. Use and storage of your digital signature</h2>
                <p>Your signature image is stored securely by RTG and used only to compile and evidence board and committee attendance registers, resolutions and related governance records. With your consent, your signature may be saved so you can reuse it on future occasions instead of re-drawing it; you can ask for it to be re-captured or removed at any time. It is retained for as long as the corresponding governance record must be kept, and is not sold or used for marketing.</p>
              </section>

              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">5. Legal compliance</h2>
                <p>RTG maintains these electronic signatures in a manner intended to comply with applicable electronic transactions and data-protection law, including the reliable association of your signature with the record and its integrity thereafter. You agree not to dispute the validity of a record solely because it was signed electronically. Nothing here limits any right you have under applicable law.</p>
              </section>

              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">6. Your data and your rights</h2>
                <p>The personal data we process for this purpose is limited to your name, the email address the link was sent to, your signature, and the time and record you signed. You may request access to, correction of, or deletion of your signature where the law allows, subject to our record-keeping obligations. Direct any request or query to the RTG Company Secretary / Legal team.</p>
              </section>

              <section>
                <h2 className="font-semibold text-neutral-900 mb-1">7. Changes</h2>
                <p>We may update these terms from time to time; the version shown when you sign is the version that applies to that signature.</p>
              </section>
            </div>
          </div>

          <p className="text-center text-xs text-neutral-400 mt-4">You can close this tab and return to your signing page.</p>
        </div>
      </div>
    </>
  );
}
