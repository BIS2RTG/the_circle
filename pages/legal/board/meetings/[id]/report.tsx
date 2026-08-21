import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { requireBgmSSR, buildMeetingDetail, jsonSafe } from '@/lib/bgmSSR';
import { useRequirePermission } from '@/contexts/RBACContext';
import { AttendanceStatus, defaultQuorum } from '@/lib/bgm';
import { ArrowLeft, Printer } from 'lucide-react';

function fmt(iso: string | null, opts: Intl.DateTimeFormatOptions) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', opts).format(new Date(iso)); } catch { return '—'; }
}
const fmtDateTime = (iso: string | null, tz?: string) => fmt(iso, { dateStyle: 'full', timeStyle: 'short', timeZone: tz });
const fmtTime = (iso: string | null) => fmt(iso, { timeStyle: 'short' });
// Simplified attendance display: Present (incl. legacy virtual) vs Apology / Absent.
const attLabel = (status: AttendanceStatus | null): string => {
  if (status === 'present' || status === 'virtual') return 'Present';
  if (status === 'apology' || status === 'absent') return 'Apology / Absent';
  return '—';
};

export default function AttendanceReport({ initial }: { initial: any }) {
  const router = useRouter();
  const { id } = router.query;
  useRequirePermission(['bgm.attendance.view', 'bgm.meetings.view', 'legal.access']);
  const data = initial;

  if (!data?.meeting) return <div className="max-w-2xl mx-auto p-8 text-center text-neutral-500">Meeting not found.</div>;

  const { meeting, register, guests, quorum } = data;
  const q = quorum ?? defaultQuorum(register.length);
  const counts: Record<AttendanceStatus, number> = { present: 0, virtual: 0, apology: 0, absent: 0 };
  for (const r of register) if (r.status) counts[r.status as AttendanceStatus] += 1;
  const attended = counts.present + counts.virtual;
  const quorumMet = attended >= q && q > 0;

  const rows = [
    ...register.map((r: any) => ({ ...r, kind: 'Director', name: r.full_name })),
    ...guests.map((g: any) => ({ ...g, kind: g.role || 'Guest', name: g.full_name })),
  ];

  return (
    <>
      <Head><title>Attendance Record · {meeting.title}</title></Head>
      <div className="min-h-screen bg-neutral-100 print:bg-white">
        {/* Toolbar (hidden when printing) */}
        <div className="print:hidden sticky top-0 z-10 bg-white border-b border-neutral-200 px-4 py-3 flex items-center justify-between">
          <Link href={`/legal/board/meetings/${id}`} className="inline-flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900">
            <ArrowLeft className="w-4 h-4" /> Back to meeting
          </Link>
          <button onClick={() => window.print()} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium">
            <Printer className="w-4 h-4" /> Print / Save as PDF
          </button>
        </div>

        {/* Document */}
        <div className="max-w-3xl mx-auto bg-white my-6 print:my-0 shadow-sm print:shadow-none p-8 sm:p-10 text-[13px] text-neutral-800">
          <div className="flex items-start justify-between border-b-2 border-neutral-800 pb-4 mb-5">
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/RTG_LOGO.png" alt="Rainbow Tourism Group" className="h-12 w-auto object-contain" />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Rainbow Tourism Group</p>
                <h1 className="text-xl font-bold text-neutral-900 mt-0.5">Board Attendance Record</h1>
              </div>
            </div>
            <div className="text-right text-[11px] text-neutral-500">
              <p>Generated {fmt(new Date().toISOString(), { dateStyle: 'medium', timeStyle: 'short' })}</p>
              {meeting.finalized_at && <p className="text-emerald-600 font-medium">Finalized {fmt(meeting.finalized_at, { dateStyle: 'medium' })}</p>}
            </div>
          </div>

          {/* Meeting meta */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 mb-5">
            <Meta label="Meeting" value={meeting.title} />
            <Meta label="Type" value={meeting.meeting_type === 'committee' ? (meeting.committee?.name || 'Committee') : 'Full Board'} />
            <Meta label="Date & time" value={fmtDateTime(meeting.scheduled_start, meeting.time_zone)} />
            <Meta label="Venue" value={meeting.is_virtual ? `Virtual${meeting.virtual_platform ? ` (${meeting.virtual_platform})` : ''}` : (meeting.location || '—')} />
          </div>

          {/* Summary */}
          <div className="flex flex-wrap gap-2 mb-5">
            <Pill label={`Quorum ${attended}/${q}`} tone={quorumMet ? 'good' : 'warn'} suffix={quorumMet ? 'met' : 'not met'} />
            <Pill label="Present" tone="neutral" suffix={String(counts.present + counts.virtual)} />
            <Pill label="Apology / Absent" tone="neutral" suffix={String(counts.apology + counts.absent)} />
            <Pill label="Invited" tone="neutral" suffix={String(register.length + guests.length)} />
          </div>

          {/* Table */}
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-neutral-500 border-y border-neutral-300">
                <th className="py-2 pr-2 font-semibold w-6">#</th>
                <th className="py-2 pr-2 font-semibold">Name</th>
                <th className="py-2 pr-2 font-semibold">Attendance</th>
                <th className="py-2 pr-2 font-semibold">Registered</th>
                <th className="py-2 font-semibold">Signature</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={`${r.kind}-${r.id || r.director_id || i}`} className="border-b border-neutral-200 align-middle">
                  <td className="py-3 pr-2 text-neutral-400">{i + 1}</td>
                  <td className="py-3 pr-2 font-medium text-neutral-900">{r.name}</td>
                  <td className="py-3 pr-2">{attLabel(r.status)}</td>
                  <td className="py-3 pr-2 text-neutral-600 whitespace-nowrap">{fmtTime(r.checked_in_at) || '—'}</td>
                  <td className="py-3">
                    {r.check_in_signature
                      /* eslint-disable-next-line @next/next/no-img-element */
                      ? <img src={r.check_in_signature} alt="signature" className="h-16 max-w-[280px] w-auto object-contain" />
                      : <span className="text-neutral-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Single sign-off */}
          <div className="mt-10 max-w-xs text-[11px] text-neutral-500">
            <div className="h-14 flex items-end">
              {meeting.finalized_signature && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={meeting.finalized_signature} alt="Signature" className="max-h-14 object-contain" />
              )}
            </div>
            <div className="border-t border-neutral-400 pt-1">
              <span className="font-medium text-neutral-700">{meeting.finalized_by_name || 'Signed off by'}</span>
              {meeting.finalized_at ? ` · ${fmt(meeting.finalized_at, { dateStyle: 'medium' })}` : ''}
            </div>
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page { margin: 14mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      ` }} />
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-neutral-400 w-24 shrink-0">{label}</span>
      <span className="font-medium text-neutral-800">{value}</span>
    </div>
  );
}
function Pill({ label, suffix, tone }: { label: string; suffix?: string; tone: 'good' | 'warn' | 'neutral' }) {
  const cls = tone === 'good' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : tone === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-neutral-50 text-neutral-600 border-neutral-200';
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${cls}`}>{label}{suffix !== undefined && <span className="font-bold">{suffix}</span>}</span>;
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const gate = await requireBgmSSR(context, ['bgm.attendance.view', 'bgm.meetings.view', 'legal.access']);
  if ('redirect' in gate) return { redirect: gate.redirect };
  const id = String(context.params?.id || '');
  const detail = await buildMeetingDetail(gate.ctx.organizationId, id);
  if (!detail) return { notFound: true };
  return { props: { initial: jsonSafe(detail) } };
};
