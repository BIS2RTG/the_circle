/**
 * Human-friendly WebAuthn error messages.
 *
 * The browser's native errors are cryptic and leak spec URLs (e.g. a cancelled
 * or timed-out ceremony throws a NotAllowedError whose message points at
 * w3.org). We never want to show those raw. Map the DOMException `name` to
 * calm, plain-English copy the user can act on. This is just an additional comment
 */
export function friendlyWebauthnError(err: any, ctx: 'register' | 'verify' = 'register'): string {
  const name: string | undefined = err?.name;
  const action = ctx === 'register' ? 'set up' : 'verify';

  switch (name) {
    case 'NotAllowedError':
      // Cancelled, dismissed, or timed out. The single most common case.
      return ctx === 'register'
        ? 'Setup was cancelled or timed out. You can try again whenever you’re ready, or skip this step for now.'
        : 'Verification was cancelled or timed out. Please try again.';
    case 'InvalidStateError':
      return 'This device is already registered on your account.';
    case 'NotSupportedError':
      return 'This browser or device doesn’t support passkeys. Try a different browser, or use your phone instead.';
    case 'SecurityError':
      return 'We couldn’t confirm this site is secure. Please make sure you’re on the official Circle address and try again.';
    case 'AbortError':
      return ctx === 'register' ? 'Setup was cancelled.' : 'Verification was cancelled.';
    case 'ConstraintError':
      return 'Your device couldn’t complete this securely. Make sure a screen lock, fingerprint, or face unlock is set up, then try again.';
    default: {
      const msg = typeof err?.message === 'string' ? err.message : '';
      // Never surface raw spec/WebAuthn jargon to the user.
      if (!msg || /w3\.org|webauthn|operation either timed out/i.test(msg)) {
        return `Something went wrong while trying to ${action} this device. Please try again.`;
      }
      return msg;
    }
  }
}
