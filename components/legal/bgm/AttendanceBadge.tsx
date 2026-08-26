import { AttendanceStatus, ATTENDANCE_LABELS, ATTENDANCE_STYLES } from '@/lib/bgm';

export default function AttendanceBadge({ status }: { status: AttendanceStatus | null }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-500">
        <span className="w-1.5 h-1.5 rounded-full bg-neutral-300" />
        Not recorded
      </span>
    );
  }
  const style = ATTENDANCE_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {ATTENDANCE_LABELS[status]}
    </span>
  );
}
