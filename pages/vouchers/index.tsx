import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AppLayout } from '../../components/layout';
import Loader from '@/components/Loader';
import { Card } from '../../components/ui';
import { useRBAC } from '../../contexts/RBACContext';

interface VoucherRow {
  id: string;
  seq: number | null;
  voucher_number: string | null;
  guest_names: string | null;
  business_units: Array<{ id: string; name: string }> | null;
  reason: string | null;
  email_sent: boolean;
  email_sent_at: string | null;
  delivered: boolean;
  delivered_at: string | null;
  created_at: string;
  request?: {
    id: string;
    title: string;
    status: string;
    creator?: { display_name?: string } | null;
  } | null;
}

function hotelLabel(units: VoucherRow['business_units']): string {
  if (!units || units.length === 0) return '—';
  if (units.some((u) => u.id === 'any')) return 'Any RTG Hotel of Choice';
  return units.map((u) => u.name).join(', ');
}

function statusBadge(status?: string) {
  const s = status || 'pending';
  const map: Record<string, string> = {
    approved: 'bg-success-50 text-success-600 border-success-100',
    pending: 'bg-amber-50 text-amber-600 border-amber-100',
    rejected: 'bg-danger-50 text-danger-600 border-danger-100',
    withdrawn: 'bg-neutral-100 text-neutral-600 border-neutral-200',
    draft: 'bg-neutral-100 text-neutral-600 border-neutral-200',
  };
  return map[s] || 'bg-neutral-100 text-neutral-600 border-neutral-200';
}

export default function VoucherRegisterPage() {
  const { status } = useSession();
  const router = useRouter();
  const { loading: rbacLoading, hasPermission } = useRBAC();
  const canView = hasPermission('vouchers.view_register');

  const [vouchers, setVouchers] = useState<VoucherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/');
  }, [status, router]);

  useEffect(() => {
    if (status !== 'authenticated' || rbacLoading || !canView) return;
    const load = async () => {
      try {
        const res = await fetch('/api/vouchers');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load vouchers');
        }
        const data = await res.json();
        setVouchers(data.vouchers || []);
      } catch (err: any) {
        setError(err.message || 'Failed to load vouchers');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [status, rbacLoading, canView]);

  const toggleDelivered = async (row: VoucherRow) => {
    setUpdatingId(row.id);
    try {
      const res = await fetch(`/api/vouchers/${row.id}/deliver`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivered: !row.delivered }),
      });
      if (!res.ok) throw new Error('Failed to update delivery status');
      const data = await res.json();
      setVouchers((prev) => prev.map((v) => (v.id === row.id ? { ...v, ...data.voucher } : v)));
    } catch (err: any) {
      setError(err.message || 'Failed to update delivery status');
    } finally {
      setUpdatingId(null);
    }
  };

  if (status === 'loading' || rbacLoading) {
    return (
      <AppLayout title="Voucher Register">
        <Loader fullScreen={false} />
      </AppLayout>
    );
  }

  if (!canView) {
    return (
      <AppLayout title="Voucher Register">
        <div className="p-4 sm:p-6 max-w-3xl mx-auto">
          <Card className="bg-danger-50 border-danger-200">
            <p className="text-danger-600 text-sm">
              You do not have permission to view the voucher register.
            </p>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Voucher Register">
      <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl border border-border p-6">
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Voucher Register</h1>
          <p className="text-text-secondary mt-1.5 text-sm max-w-2xl">
            The complimentary voucher booklet — every voucher raised, its sequential number, the
            guest(s) receiving it, and whether it has been delivered yet. Numbers are issued on
            final approval.
          </p>
        </div>

        {error && (
          <Card className="bg-danger-50 border-danger-200">
            <p className="text-danger-600 text-sm">{error}</p>
          </Card>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
          </div>
        ) : vouchers.length === 0 ? (
          <Card>
            <p className="text-sm text-text-secondary">No vouchers have been raised yet.</p>
          </Card>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-neutral-50 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    <th className="px-4 py-3">No.</th>
                    <th className="px-4 py-3">Guest(s)</th>
                    <th className="px-4 py-3">Hotel(s)</th>
                    <th className="px-4 py-3">Raised by</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Delivered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {vouchers.map((v) => (
                    <tr
                      key={v.id}
                      className={`hover:bg-neutral-50/60 ${v.request?.id ? 'cursor-pointer' : ''}`}
                      onClick={() => { if (v.request?.id) router.push(`/requests/comp/${v.request.id}`); }}
                      title={v.request?.id ? 'Open request' : ''}
                    >
                      <td className="px-4 py-3 font-mono font-bold text-text-primary whitespace-nowrap">
                        {v.voucher_number || <span className="text-xs font-sans font-normal italic text-neutral-400">pending</span>}
                      </td>
                      <td className="px-4 py-3 text-text-primary max-w-[220px] truncate" title={v.guest_names || ''}>
                        {v.guest_names || '—'}
                      </td>
                      <td className="px-4 py-3 text-text-secondary max-w-[220px] truncate" title={hotelLabel(v.business_units)}>
                        {hotelLabel(v.business_units)}
                      </td>
                      <td className="px-4 py-3 text-text-secondary whitespace-nowrap">
                        {v.request?.creator?.display_name || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border capitalize ${statusBadge(v.request?.status)}`}>
                          {v.request?.status || 'pending'}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {v.email_sent ? (
                          <span className="text-success-600 text-xs font-medium">Sent</span>
                        ) : (
                          <span className="text-neutral-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleDelivered(v); }}
                          disabled={updatingId === v.id || !v.voucher_number}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors disabled:opacity-50 ${
                            v.delivered
                              ? 'bg-success-50 text-success-600 border-success-100 hover:bg-success-100'
                              : 'bg-white text-neutral-600 border-gray-300 hover:bg-neutral-50'
                          }`}
                          title={!v.voucher_number ? 'Available once the voucher is approved' : ''}
                        >
                          {v.delivered ? 'Delivered' : 'Mark delivered'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
