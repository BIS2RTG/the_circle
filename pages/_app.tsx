import type { AppProps } from 'next/app';
import { SessionProvider, useSession } from "next-auth/react";
import Head from 'next/head';
import '../styles/globals.css';

import { ToastProvider } from '../components/ui/ToastProvider';
import { UserProvider } from '../contexts/UserContext';
import { RBACProvider } from '../contexts/RBACContext';
import Loader from '../components/Loader';
import RouteProgress from '../components/RouteProgress';
import ErrorBoundary from '../components/ErrorBoundary';
import GlobalErrorListener from '../components/GlobalErrorListener';
import NetworkStatusBanner from '../components/NetworkStatusBanner';

const SESSION_FLAG = 'the_circle_active_session';
import SessionActivityGuard from '../components/SessionActivityGuard';

function SessionGuard({ children }: { children: React.ReactNode }) {
  const { status, data } = useSession();

  // Show the loader only on the INITIAL load, before we have any session.
  // We must not blank the app when status is briefly 'loading' during a
  // background session revalidation (we already hold `data`) — doing so would
  // unmount and remount the whole page tree, resetting scroll and DOM state
  // mid-form. This prevents flashing the login UI during OAuth callback too.
  if (status === 'loading' && !data) {
    return <Loader />;
  }

  return <>{children}</>;
}

export default function App({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  // refetchOnWindowFocus is off: SessionActivityGuard already rolls the session
  // forward on activity/visibility (throttled). Leaving it on caused a redundant
  // second session refetch on every tab switch, adding lag.
  return (
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <ErrorBoundary>
        <RouteProgress />
        {/* Mounted outside SessionGuard so the offline banner shows even on the
            initial loading / sign-in screen — connectivity problems during auth
            are surfaced too, not just after the app has loaded. */}
        <NetworkStatusBanner />
        <SessionGuard>
          <UserProvider>
            <RBACProvider>
              <ToastProvider>
                <GlobalErrorListener />
                <Component {...pageProps} />
              </ToastProvider>
            </RBACProvider>
          </UserProvider>
        </SessionGuard>
      </ErrorBoundary>
      <SessionActivityGuard />
    </SessionProvider>
  );
}
