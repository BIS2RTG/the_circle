import { signOut } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState, useRef } from 'react';
import { AppLayout } from '../../components/layout';
import Loader from '@/components/Loader';

import { Card, Button } from '../../components/ui';
import dynamic from 'next/dynamic';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useUserHrimsProfile } from '../../hooks/useUserHrimsProfile';
import PermanentWatchersCard from '../../components/settings/PermanentWatchersCard';

const SignaturePad = dynamic(() => import('../../components/SignaturePad'), {
  ssr: false,
  loading: () => <div className="h-40 bg-gray-50 animate-pulse rounded-xl" />
});

export default function SettingsPage() {
  const { user, session, loading: userLoading, updateProfilePicture } = useCurrentUser();
  const { departmentName, businessUnitName, reportsTo } = useUserHrimsProfile();
  const router = useRouter();
  const [signatureUrl, setSignatureUrl] = useState<string | undefined>(undefined);
  const [profilePictureUrl, setProfilePictureUrl] = useState<string | undefined>(undefined);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!userLoading && !session) {
      router.push('/');
    }
  }, [userLoading, session, router]);

  useEffect(() => {
    if (user?.id) {
      // Private bucket: probe via the authenticated proxy (HEAD), then render it.
      checkSignature(`/api/signature/view?userId=${user.id}`);

      // Profile picture from the user's stored URL (set on upload / MS login).
      // No storage probing — if there's no URL, there's no picture.
      if (user.profile_picture_url) {
        const url = user.profile_picture_url;
        setProfilePictureUrl(url.includes('?') ? url : `${url}?t=${Date.now()}`);
      }
    }
  }, [user]);

  const checkSignature = async (baseUrl: string) => {
    try {
      // Bust the cache on every probe and on the URL we hand to the <img>. The
      // signature proxy URL is otherwise identical before and after a change,
      // so without this the browser serves the stale image (or a cached 404
      // from before an upload) for up to 5 minutes — making a just-saved
      // signature look like it never saved. (Same trick the profile picture
      // above already uses.)
      const bust = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
      const res = await fetch(bust, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) {
        setSignatureUrl(bust);
      }
    } catch (e) {
      // ignore
    }
  };

  const handleProfilePictureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    // Validate file size (max 4MB)
    if (file.size > 4 * 1024 * 1024) {
      alert('Image size must be less than 4MB');
      return;
    }

    setUploadingPicture(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      try {
        const res = await fetch('/api/user/profile-picture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64 }),
        });
        const data = await res.json();
        if (data.url) {
          // Add cache-busting parameter to force browser to load new image
          const urlWithCache = `${data.url}?t=${Date.now()}`;
          setProfilePictureUrl(urlWithCache);
          // Update the global user context so header/sidebar update immediately
          updateProfilePicture(urlWithCache);
        } else {
          alert('Failed to upload profile picture');
        }
      } catch (err) {
        console.error('Upload error', err);
        alert('Failed to upload profile picture');
      } finally {
        setUploadingPicture(false);
      }
    };
    reader.readAsDataURL(file);
  };

  if (userLoading) {
    return (
      <AppLayout title="Settings">
        <Loader fullScreen={false} />
      </AppLayout>
    );
  }

  if (!session || !user) {
    return null;
  }

  return (
    <AppLayout title="Settings">
      <div className="p-4 space-y-4 max-w-2xl mx-auto">
        {/* Profile Section */}
        <Card>
          <h3 className="font-semibold text-gray-900 mb-4">Profile</h3>
          <div className="flex items-start gap-4">
            <div className="relative group">
              <div className="w-20 h-20 rounded-full bg-brand-100 flex items-center justify-center text-brand-600 font-semibold text-2xl overflow-hidden">
                {profilePictureUrl ? (
                  <img 
                    src={profilePictureUrl} 
                    alt="Profile" 
                    className="w-full h-full object-cover"
                  />
                ) : (
                  user.display_name?.charAt(0) || user.email?.charAt(0) || '?'
                )}
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingPicture}
                className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                {uploadingPicture ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                ) : (
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleProfilePictureUpload}
                className="hidden"
              />
            </div>
            <div className="flex-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingPicture}
                className="text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                {uploadingPicture ? 'Uploading...' : 'Change photo'}
              </button>
            </div>
          </div>

          {/* User Information - Read Only */}
          <div className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">Full Name</label>
              <p className="text-gray-900 font-medium bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                {user.display_name || session.user?.name || 'Not set'}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">Email</label>
              <p className="text-gray-900 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                {user.email || session.user?.email || 'Not set'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-500 mb-1">Department</label>
                <p className="text-gray-900 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                  {departmentName || 'Not assigned'}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 mb-1">Business Unit</label>
                <p className="text-gray-900 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                  {businessUnitName || 'Not assigned'}
                </p>
              </div>
            </div>
            {/* Only rendered when the organogram resolves a manager — top
                positions (e.g. the CEO) have none, so the field is omitted. */}
            {reportsTo && (
              <div>
                <label className="block text-sm font-medium text-gray-500 mb-1">Reports To</label>
                <p className="text-gray-900 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                  {reportsTo.name}
                  {reportsTo.jobTitle && (
                    <span className="text-gray-500"> — {reportsTo.jobTitle}</span>
                  )}
                </p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">Role</label>
              <p className="text-gray-900 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200 capitalize">
                {user.role || 'User'}
              </p>
            </div>
          </div>
        </Card>

        {/* Signature Section */}
        <Card>
          <div className="mb-4">
            <h3 className="font-semibold text-gray-900">Digital Signature</h3>
            <p className="text-sm text-gray-500">
              Draw your signature, upload an image, or sign from your mobile device.
              This will be used for approval workflows.
            </p>
          </div>
          <SignaturePad
            initialUrl={signatureUrl}
            onSave={(url) => setSignatureUrl(url)}
          />
        </Card>

        {/* Preferences */}
        <Card>
          <h3 className="font-semibold text-gray-900 mb-4">Preferences</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="font-medium text-gray-900">Email Notifications</p>
                <p className="text-sm text-gray-500">Receive email for new approvals</p>
              </div>
              <button className="relative inline-flex h-6 w-11 items-center rounded-full bg-brand-500">
                <span className="translate-x-6 inline-block h-4 w-4 transform rounded-full bg-white transition" />
              </button>
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="font-medium text-gray-900">Push Notifications</p>
                <p className="text-sm text-gray-500">Get notified on your device</p>
              </div>
              <button className="relative inline-flex h-6 w-11 items-center rounded-full bg-gray-200">
                <span className="translate-x-1 inline-block h-4 w-4 transform rounded-full bg-white transition" />
              </button>
            </div>
          </div>
        </Card>

        {/* Permanent watchers */}
        <PermanentWatchersCard currentUserId={(user as any)?.id} />

        {/* Admin Section (conditional) */}
        {(user.role === 'admin' || user.role === 'owner') && (
          <Card>
            <h3 className="font-semibold text-gray-900 mb-4">Administration</h3>
            <div className="space-y-2">
              <button className="w-full flex items-center justify-between py-3 px-1 text-left hover:bg-gray-50 rounded-lg transition-colors">
                <span className="font-medium text-gray-900">Manage Users</span>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button className="w-full flex items-center justify-between py-3 px-1 text-left hover:bg-gray-50 rounded-lg transition-colors">
                <span className="font-medium text-gray-900">Workflow Templates</span>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button className="w-full flex items-center justify-between py-3 px-1 text-left hover:bg-gray-50 rounded-lg transition-colors">
                <span className="font-medium text-gray-900">Audit Logs</span>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </Card>
        )}

        {/* Sign Out */}
        <Card>
          <Button
            variant="danger"
            className="w-full"
            onClick={() => signOut({ callbackUrl: '/' })}
          >
            Sign Out
          </Button>
        </Card>

        {/* App Info */}
        <div className="text-center text-xs text-gray-400 pt-4">
          <p>The Circle v0.1.0</p>
          <p className="mt-1">Approval workflows made simple</p>
        </div>
      </div>
    </AppLayout>
  );
}
