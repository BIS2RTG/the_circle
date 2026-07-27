import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState, useMemo } from 'react';
import { useRBAC } from '../../contexts/RBACContext';
import {
  LayoutGrid,
  FilePlus2,
  ListChecks,
  FilePen,
  CircleCheck,
  FileSignature,
  TrendingUp,
  Wallet,
  Coins,
  BarChart3,
  ClipboardList,
  FileText,
  ShieldCheck,
  ShieldAlert,
  ScrollText,
  ServerCog,
  MousePointerClick,
  Gauge,
  Timer,
  GitBranch,
  UserCog,
  Bug,
  Ticket,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useRef } from 'react';

interface NavItem {
  href?: string;
  label: string;
  icon: React.ReactNode;
  children?: NavItem[];
  requiredPermissions?: string[];
  requireAny?: boolean;
  /** Anchor id for the post-onboarding feature tour. */
  dataTour?: string;
}

interface NavSection {
  title?: string;
  items: NavItem[];
  requiredPermissions?: string[];
  requireAny?: boolean;
}

const iconProps = { className: 'w-[18px] h-[18px]', strokeWidth: 1.5 } as const;

const navSections: NavSection[] = [
  {
    items: [
      {
        href: '/dashboard',
        label: 'Dashboard',
        icon: <LayoutGrid {...iconProps} />,
      },
    ],
  },
  {
    title: 'Requests',
    items: [
      {
        href: '/requests/new',
        label: 'New Request',
        icon: <FilePlus2 {...iconProps} />,
        dataTour: 'requests',
      },
      {
        href: '/requests/my-requests',
        label: 'My Requests',
        icon: <ListChecks {...iconProps} />,
      },
      {
        href: '/requests/drafts',
        label: 'My Drafts',
        icon: <FilePen {...iconProps} />,
      },
      {
        href: '/approvals',
        label: 'My Approval Tasks',
        icon: <CircleCheck {...iconProps} />,
      },
      {
        href: '/vouchers',
        label: 'Voucher Register',
        requiredPermissions: ['vouchers.view_register'],
        requireAny: true,
        icon: <Ticket {...iconProps} />,
      },
      {
        href: '/requests/esign',
        label: 'E-Sign PDF',
        icon: <FileSignature {...iconProps} />,
        dataTour: 'esign',
      },
    ],
  },
  {
    title: 'Finance',
    items: [
      {
        href: '/finance/capex-tracker',
        label: 'CAPEX Tracker',
        requiredPermissions: ['finance.view_tracker'],
        requireAny: true,
        icon: <TrendingUp {...iconProps} />,
      },
      {
        href: '/finance/supplier-payments',
        label: 'Supplier Records',
        requiredPermissions: ['finance.view_suppliers'],
        requireAny: true,
        icon: <Wallet {...iconProps} />,
      },
      {
        href: '/finance/cash-receipts',
        label: 'Cash Receipts',
        requiredPermissions: ['finance.view_cash_receipts'],
        requireAny: true,
        icon: <ClipboardList {...iconProps} />,
      },
      {
        href: '/finance/exception-reports',
        label: 'Exception Reports',
        requiredPermissions: ['finance.view_exceptions'],
        requireAny: true,
        icon: <Coins {...iconProps} />,
      },
      {
        href: '/finance/reports',
        label: 'Financial Reports',
        requiredPermissions: ['finance.view_reports'],
        requireAny: true,
        icon: <BarChart3 {...iconProps} />,
      },
    ],
  },
  {
    title: 'Audit',
    items: [
      {
        href: '/audit',
        label: 'Audit Dashboard',
        requiredPermissions: ['audit.view_dashboard', 'admin.audit_logs'],
        requireAny: true,
        icon: <Gauge {...iconProps} />,
      },
      {
        href: '/audit/logs',
        label: 'Immutable Logs',
        requiredPermissions: ['audit.view_logs', 'admin.audit_logs'],
        requireAny: true,
        icon: <ScrollText {...iconProps} />,
      },
      {
        href: '/audit/security',
        label: 'Security Events',
        requiredPermissions: ['audit.view_logs', 'admin.audit_logs'],
        requireAny: true,
        icon: <ShieldAlert {...iconProps} />,
      },
      {
        href: '/audit/system',
        label: 'System Events',
        requiredPermissions: ['audit.view_logs', 'admin.audit_logs'],
        requireAny: true,
        icon: <ServerCog {...iconProps} />,
      },
      {
        href: '/audit/activity',
        label: 'User Activity',
        requiredPermissions: ['audit.view_logs', 'admin.audit_logs'],
        requireAny: true,
        icon: <MousePointerClick {...iconProps} />,
      },
      {
        href: '/audit/transactions',
        label: 'Transactions & Workflows',
        requiredPermissions: ['audit.view_logs', 'admin.audit_logs'],
        requireAny: true,
        icon: <ClipboardList {...iconProps} />,
      },
      {
        href: '/audit/reports',
        label: 'Audit Reports',
        requiredPermissions: ['audit.export', 'admin.audit_logs'],
        requireAny: true,
        icon: <BarChart3 {...iconProps} />,
      },
    ],
  },
  {
    title: 'Administrator',
    items: [
      {
        href: '/admin/requests',
        label: 'All Requests',
        requiredPermissions: ['requests.view_all', 'admin.roles', 'admin.system_config'],
        requireAny: true,
        icon: <FileText {...iconProps} />,
      },
      {
        href: '/admin/settings/slas',
        label: 'SLAs',
        requiredPermissions: ['admin.system_config'],
        requireAny: true,
        icon: <Timer {...iconProps} />,
      },
      {
        href: '/admin/settings/rates',
        label: 'Financial Rates',
        requiredPermissions: ['admin.system_config'],
        requireAny: true,
        icon: <Coins {...iconProps} />,
      },
      {
        href: '/admin/settings/approvals',
        label: 'Workflow Config',
        requiredPermissions: ['admin.system_config'],
        requireAny: true,
        icon: <GitBranch {...iconProps} />,
      },
      {
        href: '/admin/settings/voucher-emails',
        label: 'Voucher Emails',
        requiredPermissions: ['admin.system_config'],
        requireAny: true,
        icon: <Ticket {...iconProps} />,
      },
      {
        href: '/admin/roles',
        label: 'Access and Rights',
        requiredPermissions: ['admin.roles', 'users.assign_roles', 'users.manage_access', 'admin.system_config'],
        requireAny: true,
        icon: <ShieldCheck {...iconProps} />,
      },
      {
        href: '/admin/delegations',
        label: 'Delegations',
        requiredPermissions: ['admin.system_config', 'users.manage_access'],
        requireAny: true,
        icon: <UserCog {...iconProps} />,
      },
    ],
  },
  {
    title: 'Support',
    items: [
      {
        href: '/bugs',
        label: 'Report a Bug',
        icon: <Bug {...iconProps} />,
        dataTour: 'bugs',
      },
    ],
  },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({ isOpen, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const router = useRouter();
  const { hasPermission, hasAnyPermission, hasAllPermissions, loading: rbacLoading } = useRBAC();
  const [expandedSections, setExpandedSections] = useState<string[]>(['Requests', 'Finance', 'Audit', 'Administrator', 'Support']);
  const navRef = useRef<HTMLElement>(null);

  // Preserve the nav scroll position across page navigations. The sidebar
  // remounts on each route change, which would otherwise reset it to the top —
  // so we stash the scroll offset and restore it on mount.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    try {
      const saved = sessionStorage.getItem('sidebar:scroll');
      if (saved) el.scrollTop = parseInt(saved, 10) || 0;
    } catch {}
    const onScroll = () => {
      try { sessionStorage.setItem('sidebar:scroll', String(el.scrollTop)); } catch {}
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Filter nav items based on RBAC permissions
  const filteredNavSections = useMemo(() => {
    if (rbacLoading) return []; // Hide nav while RBAC loads to prevent unauthorized flash
    return navSections
      .map(section => ({
        ...section,
        items: section.items.filter(item => {
          if (!item.requiredPermissions || item.requiredPermissions.length === 0) return true;
          return item.requireAny
            ? hasAnyPermission(item.requiredPermissions)
            : hasAllPermissions(item.requiredPermissions);
        }),
      }))
      .filter(section => section.items.length > 0);
  }, [rbacLoading, hasAnyPermission, hasAllPermissions]);

  useEffect(() => {
    if (!router.pathname.startsWith('/finance')) return;
    setExpandedSections((prev) => (prev.includes('Finance') ? prev : [...prev, 'Finance']));
  }, [router.pathname]);

  const toggleSection = (title: string) => {
    setExpandedSections((prev) =>
      prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]
    );
  };

  const isActive = (href: string) => {
    if (href === '/requests' && router.pathname.startsWith('/requests')) return true;
    // '/requests/new' has its own child routes that are separate nav items
    // (Design New Form, Custom Workflow), so it should only match exactly.
    if (href === '/requests/new') return router.pathname === '/requests/new';
    return router.pathname === href || router.pathname.startsWith(href + '/');
  };

  return (
    <>
      {/* Mobile overlay - only when expanded (isOpen true) on mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-40 lg:hidden transition-opacity duration-300"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 bg-white border-r border-border font-sans w-64 shadow-2xl lg:shadow-none transition-all duration-300 ease-in-out
          lg:translate-x-0 ${collapsed ? 'lg:w-16' : 'lg:w-64'}
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex flex-col h-full overflow-hidden">
          {/* Logo */}
          <div className={`flex items-center h-16 border-b border-border shrink-0 ${collapsed ? 'lg:justify-center lg:px-0 px-5 justify-between' : 'px-5 justify-between'}`}>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 flex items-center justify-center shrink-0">
                <svg className="w-8 h-8" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <linearGradient id="brandGradientSidebar" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#9A7545" />
                      <stop offset="100%" stopColor="#C9A574" />
                    </linearGradient>
                  </defs>
                  <path d="M 100 25
                     C 145 25, 180 60, 180 100
                     C 180 145, 145 180, 100 180
                     C 55 180, 20 145, 20 100
                     C 20 60, 52 28, 95 25
                     L 100 25
                     L 98 40
                     C 60 42, 35 65, 35 100
                     C 35 138, 65 167, 100 167
                     C 138 167, 167 138, 167 100
                     C 167 65, 140 38, 100 38
                     Z"
                    fill="url(#brandGradientSidebar)"
                  />
                </svg>
              </div>
              <span className={`text-text-primary font-bold text-lg tracking-tight whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
                The Circle
              </span>
            </div>

            {/* Collapse toggle — desktop only */}
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                className={`hidden lg:flex items-center justify-center w-7 h-7 rounded-lg text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors ${collapsed ? 'lg:absolute lg:-right-3 lg:top-4 lg:bg-white lg:border lg:border-border lg:shadow-sm' : ''}`}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                {collapsed ? <ChevronsRight className="w-4 h-4" strokeWidth={1.5} /> : <ChevronsLeft className="w-4 h-4" strokeWidth={1.5} />}
              </button>
            )}
          </div>

          {/* Navigation */}
          <nav ref={navRef} className={`flex-1 overflow-y-auto overflow-x-hidden py-4 custom-scrollbar ${collapsed ? 'lg:px-2 px-3' : 'px-3'}`}>
            {filteredNavSections.map((section, sectionIndex) => {
              const itemsVisible = collapsed || !section.title || expandedSections.includes(section.title);
              return (
                <div key={sectionIndex} className={sectionIndex > 0 ? 'mt-6' : ''}>
                  {section.title && (
                    <div className={`px-2 py-1.5 mb-1 flex items-center justify-between whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
                      <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.09em]">
                        {section.title}
                      </span>
                      <button onClick={() => toggleSection(section.title!)} className="text-neutral-400 hover:text-neutral-700 transition-colors">
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform duration-200 ${expandedSections.includes(section.title!) ? '' : '-rotate-90'}`}
                          strokeWidth={1.5}
                        />
                      </button>
                    </div>
                  )}

                  <div className={`space-y-1 transition-all duration-300 ${!itemsVisible ? 'hidden' : ''}`}>
                    {section.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href!}
                        data-tour={item.dataTour}
                        onClick={() => {
                          if (window.innerWidth < 1024) {
                            onClose();
                          }
                        }}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-normal transition-all group ${collapsed ? 'lg:justify-center lg:px-0' : ''}
                          ${isActive(item.href!)
                            ? 'bg-primary-50 text-primary-700 font-medium'
                            : 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900'
                          }
                        `}
                        title={item.label}
                      >
                        <span className={`shrink-0 ${isActive(item.href!) ? 'text-primary-600' : 'text-neutral-700 group-hover:text-neutral-900'}`}>
                          {item.icon}
                        </span>
                        <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
                          {item.label}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>
        </div>
      </aside>
    </>
  );
}
