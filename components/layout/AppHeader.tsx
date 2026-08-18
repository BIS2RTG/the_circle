import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { Menu, ChevronLeft, ChevronRight, ChevronDown, Bell, User, LogOut } from 'lucide-react';

interface AppHeaderProps {
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
  onMenuClick?: () => void;
  showMenuButton?: boolean;
}

export default function AppHeader({
  title = 'The Circle',
  showBack,
  onBack,
  onMenuClick,
  showMenuButton = false
}: AppHeaderProps) {
  const { data: session, update: updateSession } = useSession();
  const router = useRouter();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [hasUnreadNotifications, setHasUnreadNotifications] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  // Fetch profile data if session doesn't have it
  useEffect(() => {
    const sessionUser = session?.user as any;
    if (sessionUser?.profile_picture_url) {
      setProfilePhoto(sessionUser.profile_picture_url);
    }
    if (sessionUser?.display_name) {
      setDisplayName(sessionUser.display_name);
    }
    
    // If session doesn't have profile data, fetch from API
    if (session?.user?.id && (!sessionUser?.profile_picture_url || !sessionUser?.display_name)) {
      fetch('/api/user/profile')
        .then(res => res.json())
        .then(data => {
          if (data.profile_picture_url) {
            setProfilePhoto(data.profile_picture_url);
          }
          if (data.display_name) {
            setDisplayName(data.display_name);
          }
        })
        .catch(err => console.error('Error fetching profile:', err));
    }
  }, [session]);

  // Close profile dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Lightweight unread check to light up the bell dot (the bell now links
  // straight to the notifications page instead of opening a dropdown).
  useEffect(() => {
    if (!session?.user) return;
    let active = true;
    const checkUnread = () => {
      fetch('/api/notifications?unread_only=true&limit=1')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!active || !data) return;
          const counts = data.unreadCounts || {};
          const total = (counts.messages || 0) + (counts.tasks || 0);
          setHasUnreadNotifications(total > 0 || (data.notifications?.length ?? 0) > 0);
        })
        .catch(() => {});
    };
    checkUnread();
    const interval = setInterval(checkUnread, 60000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [session]);

  const sessionUser = session?.user as any;

  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-border font-sans">
      <div className="flex items-center justify-between h-14 px-4">
        {/* Left side */}
        <div className="flex items-center gap-2">
          {/* Mobile menu button */}
          {showMenuButton && (
            <button
              onClick={onMenuClick}
              className="lg:hidden p-2 -ml-2 text-text-secondary hover:text-text-primary hover:bg-neutral-100 rounded-lg transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" strokeWidth={1.5} />
            </button>
          )}
          {/* Global back / forward navigation arrows — shown on every page so
              users can always move backward and forward through their history.
              The back arrow prefers a page-supplied onBack handler (when the page
              opts into showBack) and otherwise falls back to browser history. */}
          <div className="flex items-center">
            <button
              onClick={onBack || (() => router.back())}
              className="p-2 text-text-secondary hover:text-text-primary hover:bg-neutral-100 rounded-lg transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Go back"
              title="Back"
            >
              <ChevronLeft className="w-5 h-5" strokeWidth={1.5} />
            </button>
            <button
              onClick={() => router.forward()}
              className="p-2 text-text-secondary hover:text-text-primary hover:bg-neutral-100 rounded-lg transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Go forward"
              title="Forward"
            >
              <ChevronRight className="w-5 h-5" strokeWidth={1.5} />
            </button>
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-text-primary">{title}</h1>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1 sm:gap-3">
          {session?.user && (
            <>
              {/* Organization Selector */}
              {/* <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200 cursor-default">
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
                <span className="text-sm font-medium text-gray-700">{(session?.user as any)?.business_unit?.name || 'Select Business Unit'}</span>
              </div> */}

              {/* Business Unit Selector */}
              {/* <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200 cursor-default">
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <span className="text-sm font-medium text-gray-700">{(session?.user as any)?.department?.name || 'Select Department'}</span>
              </div> */}

              {/* Notifications Bell — links straight to the notifications page */}
              <Link
                href="/notifications"
                aria-label="Notifications"
                data-tour="notifications"
                className={`relative p-2 rounded-lg transition-colors ${router.pathname === '/notifications' ? 'bg-neutral-100 text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-neutral-100'}`}
              >
                <Bell className="w-5 h-5" strokeWidth={1.5} />
                {hasUnreadNotifications && (
                  <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-primary-500 rounded-full border-2 border-white" />
                )}
              </Link>

              {/* Profile Dropdown */}
              <div className="relative" ref={profileRef}>
                <button
                  onClick={() => setIsProfileOpen(!isProfileOpen)}
                  data-tour="profile"
                  className="flex items-center gap-2 p-1.5 hover:bg-neutral-100 rounded-lg transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold text-sm overflow-hidden ring-1 ring-border">
                    {(session?.user as any)?.profile_picture_url || profilePhoto ? (
                      <img
                        src={(session?.user as any)?.profile_picture_url || profilePhoto || ''}
                        alt={(session?.user as any)?.display_name || displayName || 'Profile'}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          // If image fails to load, clear it and show initial
                          e.currentTarget.style.display = 'none';
                          setProfilePhoto(null);
                        }}
                      />
                    ) : (
                      (session?.user as any)?.display_name?.charAt(0) || displayName?.charAt(0) || (session?.user as any)?.email?.charAt(0) || 'U'
                    )}
                  </div>
                  <ChevronDown className="w-4 h-4 text-text-muted hidden sm:block" strokeWidth={1.5} />
                </button>

                {/* Dropdown Menu */}
                {isProfileOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-card-hover border border-border py-1 z-50">
                    {/* User Info */}
                    <div className="px-4 py-3 border-b border-border">
                      <p className="text-sm font-semibold text-text-primary truncate">{sessionUser?.name || 'User'}</p>
                      <p className="text-xs text-text-secondary truncate">{sessionUser?.email || ''}</p>
                    </div>

                    {/* Menu Items */}
                    <div className="py-1">
                      <Link
                        href="/system/settings"
                        onClick={() => setIsProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-secondary hover:bg-neutral-100 hover:text-text-primary transition-colors"
                      >
                        <User className="w-4 h-4 text-text-muted" strokeWidth={1.5} />
                        Profile Settings
                      </Link>
                    </div>

                    {/* Sign Out */}
                    <div className="border-t border-border py-1">
                      <button
                        onClick={() => {
                          setIsProfileOpen(false);
                          signOut({ callbackUrl: '/' });
                        }}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-danger hover:bg-danger-50 transition-colors"
                      >
                        <LogOut className="w-4 h-4" strokeWidth={1.5} />
                        Sign Out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
