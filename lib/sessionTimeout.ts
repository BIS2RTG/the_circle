/**
 * Session timeout policy — single source of truth shared by the next-auth
 * config, the edge middleware and the client-side activity guard.
 *
 *  - IDLE: a session is terminated after this much inactivity. Any user
 *    activity rolls the window forward (the client refreshes the JWT, which
 *    re-issues its `exp`). This is enforced authoritatively by the JWT
 *    `maxAge` — once the cookie's `exp` passes, `getServerSession`/`getToken`
 *    return null and every protected API responds 401.
 *
 *  - ABSOLUTE: a hard ceiling measured from login. Even a continuously active
 *    user is forced to re-authenticate once this elapses. Enforced server-side
 *    in the middleware (via the `loginAt` claim) and surfaced to the client
 *    guard so the UX matches.
 *
 * IDLE stays short so an unattended, unlocked machine is signed out quickly;
 * ABSOLUTE is the maximum length of a continuously-active session.
 */

export const IDLE_TIMEOUT_SECONDS = 15 * 60; // 15 minutes of inactivity
export const ABSOLUTE_TIMEOUT_SECONDS = 2 * 60 * 60; // 2 hours from login

export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_SECONDS * 1000;
export const ABSOLUTE_TIMEOUT_MS = ABSOLUTE_TIMEOUT_SECONDS * 1000;
