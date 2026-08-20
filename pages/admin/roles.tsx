import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../components/layout';
import { Card, Button } from '../../components/ui';
import { useRBACRoles } from '../../hooks/useRBACRoles';
import { useRBAC } from '../../contexts/RBACContext';
import { AccessConfig } from '../../components/admin/settings';
import AssistantAssignmentsCard from '../../components/admin/AssistantAssignmentsCard';
import { useToast } from '../../components/ui/ToastProvider';
import RoleFormModal from '../../components/admin/RoleFormModal';
import AssignRoleModal from '../../components/admin/AssignRoleModal';
import DemoAccountModal from '../../components/admin/DemoAccountModal';
import Loader from '../../components/Loader';

interface Permission {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
}

interface RoleWithPermissions {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  is_system: boolean;
  is_default: boolean;
  priority: number;
  permissions: Permission[];
  users_count?: number;
  created_at: string;
  updated_at: string;
}

// Role icon mapping by slug
const roleIconMap: Record<string, string> = {
  super_admin: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  system_admin: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  auditor: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
  employee: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
};
const defaultRoleIcon = 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z';


// Plain monochrome icon style matching the side navigation — no colour chips.
const brownStyle = { bg: 'bg-neutral-700', text: 'text-neutral-700', light: 'bg-transparent', border: 'border-transparent' };
const colorConfig: Record<string, { bg: string; text: string; light: string; border: string }> = {
  purple: brownStyle,
  blue: brownStyle,
  teal: brownStyle,
  gray: brownStyle,
  green: brownStyle,
  orange: brownStyle,
  indigo: brownStyle,
  red: brownStyle,
  pink: brownStyle,
  cyan: brownStyle,
};

const categoryConfig: Record<string, { label: string; icon: string; color: string }> = {
  requests: { label: 'Requests', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', color: 'text-neutral-500' },
  approvals: { label: 'Approvals', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z', color: 'text-neutral-500' },
  users: { label: 'Users', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', color: 'text-neutral-500' },
  settings: { label: 'Settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z', color: 'text-neutral-500' },
  reports: { label: 'Reports', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z', color: 'text-neutral-500' },
  admin: { label: 'Administration', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', color: 'text-neutral-500' },
  forms: { label: 'Forms', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', color: 'text-neutral-500' },
  archives: { label: 'Archives', icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4', color: 'text-neutral-500' },
  finance: { label: 'Finance', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: 'text-neutral-500' },
  data: { label: 'Data Access', icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z', color: 'text-neutral-500' },
  custom_forms: { label: 'Custom Forms', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z', color: 'text-neutral-500' },
};

export default function AdminRolesPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { roles, permissions: allPermissions, loading, error, refetch, deleteRole, createRole, updateRole, assignRole, revokeRole } = useRBACRoles();
  const { hasPermission, isSuperAdmin, loading: rbacLoading } = useRBAC();
  const { addToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleWithPermissions | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);

  // Demo-only feature flag (set on staging only)
  const demoEnabled = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

  // Modal state
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleWithPermissions | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [assignUserId, setAssignUserId] = useState<string | undefined>(undefined);

  // Users section (click a user to manage their roles, scope, and permissions)
  const [showUsers, setShowUsers] = useState(false);
  const [usersList, setUsersList] = useState<Array<{ id: string; display_name: string | null; email: string; job_title?: string | null; profile_picture_url?: string | null }>>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userSearch, setUserSearch] = useState('');

  const fetchUsersList = () => {
    setUsersLoading(true);
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => setUsersList(d.users || []))
      .catch(() => addToast({ type: 'error', message: 'Failed to load users' }))
      .finally(() => setUsersLoading(false));
  };

  useEffect(() => {
    if (showUsers && usersList.length === 0) fetchUsersList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showUsers]);

  const openUserAccess = (userId: string) => {
    setAssignUserId(userId);
    setShowAssignModal(true);
  };

  const openCreateRole = () => { setEditingRole(null); setShowRoleModal(true); };
  const openEditRole = (role: RoleWithPermissions) => { setEditingRole(role); setShowRoleModal(true); };
  const openDuplicateRole = (role: RoleWithPermissions) => {
    // Strip id + slug so the form treats it as a brand-new role (slug regenerates).
    setEditingRole({ ...role, id: '', name: `${role.name} Copy`, slug: '', is_system: false } as RoleWithPermissions);
    setShowRoleModal(true);
  };

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/');
    }
  }, [status, router]);

  const filteredRoles = roles.filter((role) => {
    return (
      role.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (role.description || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  const stats = {
    total: roles.length,
    system: roles.filter((r) => r.is_system).length,
    custom: roles.filter((r) => !r.is_system).length,
    totalUsers: roles.reduce((sum, r) => sum + (r.users_count || 0), 0),
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const getPermissionsByCategory = (perms: Permission[]) => {
    const grouped: Record<string, Permission[]> = {};
    perms.forEach((permission) => {
      if (!grouped[permission.category]) {
        grouped[permission.category] = [];
      }
      grouped[permission.category].push(permission);
    });
    return grouped;
  };

  const getRoleIcon = (role: RoleWithPermissions) => {
    return roleIconMap[role.slug] || defaultRoleIcon;
  };

  const handleDeleteRole = async (roleId: string) => {
    if (!confirm('Are you sure you want to delete this role? Users assigned to it will lose these permissions.')) return;
    try {
      await deleteRole(roleId);
      addToast({ type: 'success', message: 'Role deleted' });
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to delete role' });
    }
  };

  if (status === 'loading' || loading || rbacLoading) {
    return (
      <AppLayout title="Roles">
        <Loader fullScreen={false} label="Loading roles…" />
      </AppLayout>
    );
  }

  if (!session) return null;

  // Role management is for super admins / system admins (or anyone explicitly
  // granted the admin permissions).
  const canManageRoles = isSuperAdmin || hasPermission('admin.roles') || hasPermission('users.assign_roles');
  if (!canManageRoles) {
    return (
      <AppLayout title="Role Management">
        <div className="mx-auto max-w-3xl p-6">
          <Card>
            <h2 className="mb-2 text-lg font-semibold text-gray-900">Access Restricted</h2>
            <p className="text-gray-600">You do not have permission to manage roles. Contact a system administrator.</p>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // System-role permissions are editable by super admins only; custom roles by
  // anyone allowed onto this page.
  const canEditRole = (role: RoleWithPermissions) => !role.is_system || isSuperAdmin;

  return (
    <AppLayout title="Role Management">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 font-heading">Role Management</h1>
            <p className="text-gray-500 mt-1">Define roles and permissions for your organization</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {demoEnabled && (
              <Button
                variant="secondary"
                onClick={() => setShowDemoModal(true)}
                className="flex items-center gap-2 !border-[#9A7545] !text-[#9A7545]"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
                Add demo account
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => setShowPermissions(!showPermissions)}
              className="flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
              {showPermissions ? 'Hide' : 'View'} All Permissions
            </Button>
            <Button
              variant={showUsers ? 'primary' : 'secondary'}
              onClick={() => setShowUsers((v) => !v)}
              className="flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {showUsers ? 'Hide Users' : 'Manage Users'}
            </Button>
            <Button
              variant="primary"
              onClick={openCreateRole}
              className="flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Create Role
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Card className="!p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
            <div className="text-sm text-gray-500">Total Roles</div>
          </Card>
          <Card className="!p-4">
            <div className="text-2xl font-bold text-[#9A7545]">{stats.system}</div>
            <div className="text-sm text-gray-500">System Roles</div>
          </Card>
          <Card className="!p-4">
            <div className="text-2xl font-bold text-[#9A7545]">{stats.custom}</div>
            <div className="text-sm text-gray-500">Custom Roles</div>
          </Card>
          <Card className="!p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.totalUsers}</div>
            <div className="text-sm text-gray-500">Users Assigned</div>
          </Card>
        </div>

        {/* Users Panel — click a user to manage their roles, data scope, and permission overrides */}
        {showUsers && (
          <Card className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Users</h2>
                <p className="text-sm text-gray-500">Click a user to edit their roles, data access scope, and individual permissions.</p>
              </div>
              <span className="text-sm text-gray-500">{usersList.length} users</span>
            </div>

            <div className="relative mb-4">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search users by name or email..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>

            {usersLoading ? (
              <Loader fullScreen={false} size={120} />
            ) : (
              <div className="divide-y divide-gray-100 max-h-[26rem] overflow-y-auto rounded-xl border border-gray-100">
                {usersList
                  .filter((u) => {
                    const q = userSearch.toLowerCase();
                    return (u.display_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
                  })
                  .map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => openUserAccess(u.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-xs font-semibold text-gray-600 overflow-hidden flex-shrink-0">
                        {u.profile_picture_url ? (
                          <img src={u.profile_picture_url} alt={u.display_name || u.email} className="w-full h-full object-cover" />
                        ) : (
                          (u.display_name || u.email).slice(0, 2).toUpperCase()
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{u.display_name || 'Unnamed'}</p>
                        <p className="text-xs text-gray-500 truncate">{u.email}{u.job_title ? ` · ${u.job_title}` : ''}</p>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 flex-shrink-0">
                        Manage access
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                        </svg>
                      </span>
                    </button>
                  ))}
                {usersList.filter((u) => {
                  const q = userSearch.toLowerCase();
                  return (u.display_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
                }).length === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-gray-400">No users found</div>
                )}
              </div>
            )}
          </Card>
        )}

        {/* All Permissions Panel */}
        {showPermissions && (
          <Card className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">All Available Permissions</h2>
              <span className="text-sm text-gray-500">{allPermissions.length} permissions</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from(new Set(allPermissions.map((p) => p.category))).map((category) => {
                const config = categoryConfig[category] || {
                  label: category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                  icon: defaultRoleIcon,
                  color: 'text-neutral-500',
                };
                const categoryPermissions = allPermissions.filter((p) => p.category === category);
                if (categoryPermissions.length === 0) return null;
                return (
                  <div key={category} className="border border-gray-200 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <svg className={`w-5 h-5 ${config.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={config.icon} />
                      </svg>
                      <h3 className="font-medium text-gray-900">{config.label}</h3>
                      <span className="text-xs text-gray-400">({categoryPermissions.length})</span>
                    </div>
                    <div className="space-y-2">
                      {categoryPermissions.map((permission) => (
                        <div key={permission.id} className="flex items-start gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-gray-400 mt-2 flex-shrink-0" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">{permission.name}</p>
                            <p className="text-xs text-gray-500">{permission.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search roles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Roles Grid */}
        {filteredRoles.length === 0 ? (
          <Card className="text-center py-12">
            <svg className="w-16 h-16 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <h3 className="text-lg font-medium text-gray-600 mb-1">No roles found</h3>
            <p className="text-gray-400">Try adjusting your search terms</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredRoles.map((role) => {
              const colorInfo = colorConfig[role.color] || colorConfig.gray;
              const permissionsByCategory = getPermissionsByCategory(role.permissions);
              const isExpanded = selectedRole?.id === role.id;

              return (
                <Card
                  key={role.id}
                  variant="outlined"
                  className={`transition-all ${isExpanded ? 'ring-2 ring-brand-500 border-brand-200' : 'hover:shadow-card-hover'}`}
                >
                  {/* Role Header */}
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className={`w-12 h-12 ${colorInfo.light} rounded-xl flex items-center justify-center flex-shrink-0`}>
                      <svg className={`w-6 h-6 ${colorInfo.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={getRoleIcon(role)} />
                      </svg>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-gray-900">{role.name}</h3>
                            {role.is_system && (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-[#F3EADC] text-[#5E4426]">
                                System
                              </span>
                            )}
                            {role.is_default && (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                                Default
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{role.description}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setSelectedRole(isExpanded ? null : role)}
                            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                            title={isExpanded ? 'Collapse' : 'Expand'}
                          >
                            <svg
                              className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                          {canEditRole(role) && (
                            <button
                              onClick={() => openEditRole(role)}
                              className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                              title={role.is_system ? 'Edit role (system role — super admin)' : 'Edit role'}
                            >
                              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Meta Info */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                          </svg>
                          {role.users_count || 0} user{(role.users_count || 0) !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                          </svg>
                          {role.permissions.length} permission{role.permissions.length !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Updated {formatDate(role.updated_at)}
                        </span>
                      </div>

                      {/* Permission Categories Summary */}
                      <div className="flex flex-wrap gap-2 mt-3">
                        {Object.entries(permissionsByCategory).map(([category, permissions]) => {
                          const catConfig = categoryConfig[category] || categoryConfig.admin;
                          return (
                            <span
                              key={category}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-50 text-xs text-gray-600"
                            >
                              <svg className={`w-3 h-3 ${catConfig.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={catConfig.icon} />
                              </svg>
                              {catConfig.label} ({permissions.length})
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Permissions */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-medium text-gray-900">Permissions</h4>
                        {canEditRole(role) && (
                          <Button variant="secondary" onClick={() => openEditRole(role)} className="text-sm">
                            Edit Permissions
                          </Button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {Object.entries(permissionsByCategory).map(([category, permissions]) => {
                          const catConfig = categoryConfig[category] || categoryConfig.admin;
                          return (
                            <div key={category} className="bg-gray-50 rounded-xl p-3">
                              <div className="flex items-center gap-2 mb-2">
                                <svg className={`w-4 h-4 ${catConfig.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={catConfig.icon} />
                                </svg>
                                <span className="text-sm font-medium text-gray-700">{catConfig.label}</span>
                              </div>
                              <div className="space-y-1">
                                {permissions.map((permission) => (
                                  <div key={permission.id} className="flex items-center gap-2 text-sm">
                                    <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                    <span className="text-gray-600">{permission.name}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
                        <div className="text-xs text-gray-500">
                          Created {formatDate(role.created_at)}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            onClick={() => router.push(`/admin/users?role=${role.id}`)}
                            className="text-sm"
                          >
                            View Users
                          </Button>
                          {!role.is_system && (
                            <>
                              <Button variant="secondary" onClick={() => openDuplicateRole(role)} className="text-sm">
                                Duplicate
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={() => handleDeleteRole(role.id)}
                                className="text-sm text-red-600 hover:bg-red-50"
                              >
                                Delete
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Access & Rights (merged from System Configuration) */}
        <div className="mt-10 pt-8 border-t border-border">
          <AccessConfig onSelectUser={openUserAccess} />
        </div>

        {/* Assistants & delegates — who may file / watch on behalf of whom */}
        <div className="mt-6">
          <AssistantAssignmentsCard />
        </div>

        {/* Help Section */}
        <Card className="mt-6 bg-neutral-50 border-border">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-neutral-700">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium text-[#3F2D19]">Understanding Roles & Permissions</h3>
              <p className="text-sm text-[#5E4426] mt-1">
                Roles define what actions users can perform in the system. <strong>System roles</strong> are pre-configured and cannot be deleted,
                but you can create <strong>custom roles</strong> tailored to your organization&apos;s needs.
                The <strong>default role</strong> is automatically assigned to new users.
              </p>
            </div>
          </div>
        </Card>

        {/* Create / Edit / Duplicate role */}
        <RoleFormModal
          isOpen={showRoleModal}
          onClose={() => setShowRoleModal(false)}
          role={editingRole}
          permissions={allPermissions}
          onCreate={createRole}
          onUpdate={updateRole}
          onSaved={refetch}
        />

        {/* Assign roles, data scope, and per-user permission overrides */}
        <AssignRoleModal
          isOpen={showAssignModal}
          onClose={() => { setShowAssignModal(false); setAssignUserId(undefined); }}
          roles={roles}
          permissions={allPermissions}
          initialUserId={assignUserId}
          assignRole={assignRole}
          revokeRole={revokeRole}
        />

        {/* Demo account creation (staging only) */}
        {demoEnabled && (
          <DemoAccountModal
            isOpen={showDemoModal}
            onClose={() => setShowDemoModal(false)}
            roles={roles}
            onCreated={refetch}
          />
        )}
      </div>
    </AppLayout>
  );
}
