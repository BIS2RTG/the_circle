import NextAuth, { NextAuthOptions } from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import { verifyDemoPassword } from "../../../lib/demoPassword";
import { supabaseAdmin } from "../../../lib/supabaseAdmin";
import { recordAuditEvent } from "../../../lib/auditLog";
import { IDLE_TIMEOUT_SECONDS } from "../../../lib/sessionTimeout";
import { saveMsTokens, MS_SCOPE } from "../../../lib/msTokenStore";
import { verifyApprovalLinkToken } from "../../../lib/approvalLinkToken";

/**
 * Identity normalisation for Azure sign-ins.
 *
 * - `*@rtgzim.onmicrosoft.com` accounts are blocked outright (users must sign
 *   in with their real `@rtg.co.zw` mailbox identity).
 * - Admin accounts (`firstname.lastname-a@rtg.co.zw`) must NOT spawn a second
 *   Circle profile: when the matching base account (`firstname.lastname@rtg.co.zw`)
 *   exists, the session is linked to that original app_users row instead.
 */
const BLOCKED_EMAIL_DOMAINS = [/@rtgzim\.onmicrosoft\.com$/i];

export function isBlockedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return BLOCKED_EMAIL_DOMAINS.some((re) => re.test(email.trim()));
}

/** kilford.runhare-a@rtg.co.zw -> kilford.runhare@rtg.co.zw (null if not an admin variant). */
export function adminBaseEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const m = email.trim().match(/^(.+)-a@(rtg\.co\.zw)$/i);
  return m ? `${m[1]}@${m[2]}` : null;
}

/** Resolve the email an Azure profile signed in with, across all claim shapes. */
function emailFromProfile(profile: any, user: any, fallback?: unknown): string | null {
  return (
    profile?.email ||
    profile?.preferred_username ||
    profile?.upn ||
    profile?.mail ||
    user?.email ||
    (typeof fallback === "string" ? fallback : null) ||
    null
  );
}

// DEMO MODE — staging only. When DEMO_MODE=true (set ONLY on the staging
// deployment, never in production) we additionally enable an email/password
// "Credentials" provider so controlled, non-Microsoft demo accounts can sign
// in. In production DEMO_MODE is unset, so this provider is never registered
// and Azure AD remains the sole authentication path.
const DEMO_MODE = process.env.DEMO_MODE === "true";

// Validate required environment variables at startup
const requiredEnvVars = {
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([_, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(", ")}`);
}

const providers: NextAuthOptions["providers"] = [
  AzureADProvider({
    clientId: process.env.AZURE_CLIENT_ID || "",
    clientSecret: process.env.AZURE_CLIENT_SECRET || "",
    tenantId: process.env.AZURE_TENANT || "common",
    // next-auth's underlying openid-client defaults to a 3.5s timeout on the
    // server-to-Microsoft calls (OIDC discovery, token exchange, JWKS). On
    // slower networks / VPNs that isn't enough and the callback fails with
    // "outgoing request timed out after 3500ms". Give it real headroom.
    httpOptions: { timeout: 20000 },
    authorization: {
      params: {
        scope: MS_SCOPE,
        prompt: "select_account",
      },
    },
  }),
  // Magic-link sign-in for approval emails. The link carries an HMAC-signed
  // token bound to (approver, request); clicking it signs that approver in and
  // drops them on the request to sign — no separate login. Registered in every
  // environment because approvals happen in production.
  CredentialsProvider({
    id: "approval-link",
    name: "Approval Link",
    credentials: {
      token: { label: "Token", type: "text" },
    },
    async authorize(credentials) {
      const token = credentials?.token;
      if (!token || !supabaseAdmin) return null;

      const parsed = verifyApprovalLinkToken(token);
      if (!parsed) return null;

      // Defence in depth: the token is signed, but re-check the user really is
      // an approver on that request before granting a session.
      const { data: step } = await supabaseAdmin
        .from("request_steps")
        .select("id")
        .eq("request_id", parsed.requestId)
        .eq("approver_user_id", parsed.approverId)
        .limit(1)
        .maybeSingle();
      if (!step) return null;

      const { data: appUser } = await supabaseAdmin
        .from("app_users")
        .select("id, organization_id, role, display_name, email")
        .eq("id", parsed.approverId)
        .maybeSingle();
      if (!appUser) return null;

      return {
        id: appUser.id,
        email: appUser.email,
        name: appUser.display_name || appUser.email,
        org_id: appUser.organization_id,
        role: appUser.role || "requester",
      } as any;
    },
  }),
];

// Staging-only demo login. Validates an email/password against the `demo_users`
// table (which lives only in the staging Supabase project) and then links the
// session to the matching `app_users` row so HRIMS auto-detection and approver
// resolution work exactly as they do for a real Microsoft sign-in.
if (DEMO_MODE) {
  providers.push(
    CredentialsProvider({
      id: "credentials",
      name: "Demo Account",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Defence in depth: never authorize via credentials outside demo mode.
        if (process.env.DEMO_MODE !== "true") return null;
        if (!supabaseAdmin) {
          console.error("Demo authorize: supabaseAdmin not initialized");
          return null;
        }
        const email = credentials?.email?.trim();
        const password = credentials?.password;
        if (!email || !password) return null;

        // 1. Look up the controlled demo account (staging-only table)
        const { data: demo, error: demoErr } = await supabaseAdmin
          .from("demo_users")
          .select("email, password_hash, display_name, is_active")
          .ilike("email", email)
          .limit(1)
          .single();

        if (demoErr || !demo || demo.is_active === false) return null;

        // 2. Verify the password against the stored scrypt hash
        const valid = await verifyDemoPassword(demo.password_hash, password);
        if (!valid) return null;

        // 3. Link to the app_users row (seeded with a matching email). This row
        //    supplies the org/role and is what the rest of the app keys on.
        //    IMPORTANT: the resolved id must be STABLE across logins — user data
        //    (biometric credentials, signatures, requests) hangs off it. If the
        //    email matches more than one row (e.g. a real Azure identity plus a
        //    seeded demo identity), prefer the demo-seeded row, then the oldest.
        const { data: appUserRows } = await supabaseAdmin
          .from("app_users")
          .select("id, organization_id, role, display_name, email, azure_oid, created_at")
          .ilike("email", demo.email)
          .order("created_at", { ascending: true });

        const demoOid = `demo:${demo.email}`.toLowerCase();
        const appUser =
          (appUserRows || []).find(
            (u) => (u.azure_oid || "").toLowerCase() === demoOid
          ) ||
          (appUserRows || []).find((u) =>
            (u.azure_oid || "").toLowerCase().startsWith("demo:")
          ) ||
          (appUserRows || [])[0];

        if (!appUser) {
          console.error(`Demo authorize: no app_users row for ${demo.email}`);
          return null;
        }

        return {
          id: appUser.id,
          email: appUser.email,
          name: appUser.display_name || demo.display_name || appUser.email,
          org_id: appUser.organization_id,
          role: appUser.role || "requester",
        } as any;
      },
    })
  );
}

export const authOptions: NextAuthOptions = {
  providers,
  secret: process.env.NEXTAUTH_SECRET || "fallback-secret-for-build-only",
  debug: true, // Enable debug mode to see errors in logs
  session: {
    strategy: "jwt",
    // Idle timeout: the cookie's exp is this far in the future and is rolled
    // forward whenever the client refreshes the session on user activity (see
    // SessionActivityGuard). Once it lapses, getServerSession/getToken return
    // null and every protected API responds 401. The absolute (2 hour) ceiling
    // is enforced separately in middleware via the `loginAt` claim.
    maxAge: IDLE_TIMEOUT_SECONDS, // 15 minutes of inactivity
    updateAge: 60, // re-issue the rolling token at most once per minute
  },
  jwt: {
    maxAge: IDLE_TIMEOUT_SECONDS, // 15 minutes
  },
  cookies: {
    sessionToken: {
      name: `next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        // No maxAge means cookie is deleted when browser closes (session cookie)
      },
    },
  },
  pages: {
    error: "/auth/error", // Custom error page
    // NextAuth redirects OAuth* errors to the signin page (not the error page),
    // so we point signin at the error page too. Real sign-in is initiated by
    // calling signIn("azure-ad") directly, which bypasses this page.
    signIn: "/auth/error",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      try {
        // Demo credentials are already validated in `authorize` against the
        // controlled demo_users table; skip the Azure tenant registration check.
        if (account?.provider === "credentials") {
          return DEMO_MODE;
        }

        // Approval magic-link: the token was verified and the user confirmed to
        // be an approver on the request inside authorize(), so allow it.
        if (account?.provider === "approval-link") {
          return true;
        }

        if (!supabaseAdmin) {
          console.error("supabaseAdmin not initialized - check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
          return false;
        }

        // Block *.onmicrosoft.com fallback identities — users must sign in
        // with their real mailbox account (e.g. name@rtg.co.zw).
        const signInEmail = emailFromProfile(profile, user);
        if (isBlockedEmail(signInEmail)) {
          console.log(`Sign-in denied: onmicrosoft account ${signInEmail}`);
          return false;
        }

        // profile contains oid and tid from Azure AD
        const tid = (profile as any)?.tid;
        if (!tid) {
          console.error("No tenant ID (tid) in profile");
          return false;
        }

        // Look up organization by Azure tenant ID
        const { data: org, error } = await supabaseAdmin
          .from("organizations")
          .select("id")
          .eq("azure_tenant_id", tid)
          .limit(1)
          .single();

        if (error) {
          console.error("Supabase error in signIn:", error.message);
        }

        if (!org) {
          // Organization not registered - deny sign in
          console.log(`Sign-in denied: tenant ${tid} not registered`);
          return false;
        }

        return true;
      } catch (err) {
        console.error("signIn callback error:", err);
        return false;
      }
    },

    async jwt({ token, user, account, profile }) {
      try {
        // Stamp the absolute-timeout anchor on every fresh sign-in (account is
        // only present at sign-in). Refreshes carry it forward untouched, so the
        // 2-hour absolute ceiling is measured from the original login.
        if (account) {
          (token as any).loginAt = Date.now();
        }

        // Demo credentials OR approval magic-link sign-in: the authorize()
        // callback already resolved the app_users row, so copy its identity onto
        // the token and skip all Azure/Graph-specific logic (no MS token here).
        if ((account?.provider === "credentials" || account?.provider === "approval-link") && user) {
          const u = user as any;
          token.user_id = u.id;
          token.org_id = u.org_id;
          token.role = u.role;
          token.email = u.email;
          return token;
        }

        // On first sign in, capture the Microsoft Graph tokens so downstream
        // delegated calls (e.g. /me/sendMail used by the e-sign invite flow) can
        // use them. These are NOT stored on the JWT/cookie — they're persisted
        // server-side in `ms_oauth_tokens` once we've resolved the app_users id
        // below (see the appUser block). Silent refresh now happens lazily at
        // consumption time via getValidMsAccessToken().
        const capturedMsTokens = account?.access_token
          ? {
              accessToken: account.access_token,
              refreshToken: account.refresh_token ?? null,
              expiresAt: account.expires_at
                ? account.expires_at * 1000
                : Date.now() + 55 * 60 * 1000,
            }
          : null;

        // On first sign in, always capture the email from all possible Azure AD sources
        if (profile || user) {
          const resolvedEmail =
            (profile as any)?.email ||
            (profile as any)?.preferred_username ||
            (profile as any)?.upn ||
            (profile as any)?.mail ||
            user?.email ||
            token.email;
          if (resolvedEmail) {
            token.email = resolvedEmail;
          }
        }

        // On first sign in, add org_id and azure_oid to token
        if (profile && supabaseAdmin) {
          const tid = (profile as any)?.tid;
          const oid = (profile as any)?.oid;
          const email = token.email; // Already resolved above from all sources

          // Find organization
          const { data: org, error: orgError } = await supabaseAdmin
            .from("organizations")
            .select("id")
            .eq("azure_tenant_id", tid)
            .limit(1)
            .single();

          if (orgError) {
            console.error("Supabase error fetching org in jwt:", orgError.message);
          }

          if (org?.id) {
            token.org_id = org.id;
            token.azure_oid = oid;

            // Resolve the Circle profile for this sign-in:
            //  1) Admin accounts (name-a@rtg.co.zw) link to the BASE account row
            //     when it exists — an admin sign-in must never create or use a
            //     separate Circle profile.
            //  2) Otherwise the row keyed by this azure_oid.
            //  3) Otherwise adopt an existing row with the same email (covers
            //     rows created before this Azure identity was seen) instead of
            //     inserting a duplicate.
            const userSelect = "id, role, profile_picture_url, display_name, email, azure_oid";
            const emailStr = typeof email === "string" ? email : "";
            const baseEmail = adminBaseEmail(emailStr);

            let existingUser: any = null;
            // Matched a row that belongs to a DIFFERENT Azure identity (base
            // account / pre-seeded email row) — never overwrite its identity
            // fields with this sign-in's.
            let matchedByFallback = false;

            if (baseEmail) {
              const { data } = await supabaseAdmin
                .from("app_users")
                .select(userSelect)
                .eq("organization_id", org.id)
                .ilike("email", baseEmail)
                .order("created_at", { ascending: true })
                .limit(1)
                .maybeSingle();
              if (data) {
                existingUser = data;
                matchedByFallback = true;
              }
            }
            if (!existingUser) {
              const { data } = await supabaseAdmin
                .from("app_users")
                .select(userSelect)
                .eq("organization_id", org.id)
                .eq("azure_oid", oid)
                .maybeSingle();
              existingUser = data;
            }
            if (!existingUser && emailStr) {
              const { data } = await supabaseAdmin
                .from("app_users")
                .select(userSelect)
                .eq("organization_id", org.id)
                .ilike("email", emailStr)
                .order("created_at", { ascending: true })
                .limit(1)
                .maybeSingle();
              if (data) {
                existingUser = data;
                matchedByFallback = true;
              }
            }

            let profilePictureUrl = existingUser?.profile_picture_url || null;
            let displayName = existingUser?.display_name || token.name || user?.name || null;

            // If user doesn't have a profile picture, try to fetch from Microsoft Graph
            if (!profilePictureUrl && account?.access_token) {
              try {
                const photoResponse = await fetch(
                  "https://graph.microsoft.com/v1.0/me/photo/$value",
                  {
                    headers: {
                      Authorization: `Bearer ${account.access_token}`,
                    },
                  }
                );

                if (photoResponse.ok) {
                  const photoBuffer = await photoResponse.arrayBuffer();
                  const buffer = Buffer.from(photoBuffer);
                  
                  // Upload to Supabase storage
                  const filePath = `${existingUser?.id || oid}.png`;
                  const { error: uploadError } = await supabaseAdmin.storage
                    .from("profile_pictures")
                    .upload(filePath, buffer, {
                      contentType: "image/png",
                      upsert: true,
                    });

                  if (!uploadError) {
                    const { data: { publicUrl } } = supabaseAdmin.storage
                      .from("profile_pictures")
                      .getPublicUrl(filePath);
                    profilePictureUrl = publicUrl;
                  } else {
                    console.error("Error uploading MS profile picture:", uploadError.message);
                  }
                }
              } catch (photoErr) {
                console.error("Error fetching MS profile picture:", photoErr);
              }
            }

            let appUser: { id: string; role: string | null } | null = null;

            if (matchedByFallback && existingUser) {
              // Linked to the original account (admin variant or email match).
              // Leave its email/azure_oid/display_name untouched — only
              // backfill a missing profile picture.
              if (profilePictureUrl && !existingUser.profile_picture_url) {
                await supabaseAdmin
                  .from("app_users")
                  .update({ profile_picture_url: profilePictureUrl })
                  .eq("id", existingUser.id);
              }
              appUser = { id: existingUser.id, role: existingUser.role ?? null };
              // Present the ORIGINAL account's email on the session so HRIMS
              // matching and display use the base identity, not the -a variant.
              if (existingUser.email) {
                token.email = existingUser.email;
              }
            } else {
              // Upsert user record in app_users
              const upsertData: any = {
                organization_id: org.id,
                azure_oid: oid,
                email: email,
                display_name: displayName,
              };

              // Only set profile_picture_url if we fetched one and user doesn't have one
              if (profilePictureUrl && !existingUser?.profile_picture_url) {
                upsertData.profile_picture_url = profilePictureUrl;
              }

              const { data: upserted, error: userError } = await supabaseAdmin
                .from("app_users")
                .upsert(upsertData, { onConflict: "organization_id,azure_oid" })
                .select("id, role")
                .single();

              if (userError) {
                console.error("Supabase error upserting user in jwt:", userError.message);
              }
              appUser = upserted;
            }

            if (appUser) {
              token.user_id = appUser.id;
              token.role = appUser.role ?? undefined;
              // Note: profile_picture_url and display_name are NOT stored in JWT to reduce cookie size
              // They should be fetched from the database when needed via useCurrentUser hook

              // Persist the freshly-captured Graph tokens server-side (keyed by
              // app_users.id) instead of on the cookie.
              if (capturedMsTokens) {
                await saveMsTokens(appUser.id, capturedMsTokens);
              }
            }
          }
        }
      } catch (err) {
        console.error("jwt callback error:", err);
      }
      return token;
    },

    async session({ session, token }) {
      // Expose org_id, user_id, and role to the client session
      // Note: profile_picture_url and display_name are fetched via useCurrentUser hook to reduce JWT size
      if (session.user) {
        (session.user as any).org_id = token.org_id;
        (session.user as any).azure_oid = token.azure_oid;
        (session.user as any).id = token.user_id;
        (session.user as any).role = token.role;
        // Ensure email is always available on the session
        if (token.email) {
          session.user.email = token.email as string;
        }
      }
      // Surface the login time so the client guard can enforce the absolute
      // (2 hour) timeout and show the matching UX.
      if (typeof (token as any).loginAt === "number") {
        (session as any).loginAt = (token as any).loginAt;
      }
      return session;
    },

    async redirect({ url, baseUrl }) {
      const dashboard = `${baseUrl}/dashboard`;
      // Bare sign-in with no specific destination → dashboard.
      if (url === baseUrl || url === `${baseUrl}/`) return dashboard;
      // Honour a relative deep link (e.g. an approval email → sign in →
      // /requests/{id}) so the approver lands exactly where they were headed
      // instead of the dashboard.
      if (url.startsWith('/') && !url.startsWith('//')) return `${baseUrl}${url}`;
      // Honour a same-origin absolute URL; reject anything cross-origin.
      try {
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        /* not a parseable URL */
      }
      return dashboard;
    },
  },

  // Immutable security audit trail for authentication lifecycle events.
  events: {
    async signIn({ user, account }) {
      await recordAuditEvent({
        category: "security",
        action: "auth.login",
        severity: "notice",
        actor: { email: user?.email || null, name: user?.name || null },
        details: { provider: account?.provider || "unknown" },
      });
    },
    async signOut({ token }) {
      await recordAuditEvent({
        category: "security",
        action: "auth.logout",
        organizationId: (token as any)?.org_id || null,
        actor: {
          id: (token as any)?.user_id || null,
          email: (token as any)?.email || null,
          name: (token as any)?.name || null,
        },
      });
    },
  },
};

export default NextAuth(authOptions);
