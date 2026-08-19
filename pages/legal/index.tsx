import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../api/auth/[...nextauth]';
import { useRequirePermission } from '@/contexts/RBACContext';
import { AppLayout } from '../../components/layout';
import { Card } from '../../components/ui';
import { Landmark, FileText, ShieldCheck, ArrowRight, Lock } from 'lucide-react';

interface SubSystem {
  key: string;
  name: string;
  prefix: string;
  description: string;
  href: string | null;
  icon: React.ReactNode;
  available: boolean;
}

export default function LegalHome() {
  useRequirePermission(['legal.access', 'bgm.meetings.view', 'bgm.directors.view']);
  const subsystems: SubSystem[] = [
    {
      key: 'bgm',
      name: 'Board Governance',
      prefix: 'BGM',
      description: 'Schedule meetings, run the digital attendance register, issue e-signed governance declarations and track board resolutions to responsible owners.',
      href: '/legal/board',
      icon: <Landmark className="w-6 h-6" strokeWidth={1.5} />,
      available: true,
    },
    {
      key: 'clm',
      name: 'Contract Lifecycle',
      prefix: 'CLM',
      description: 'Centralised contract repository, template library, multi-stage approvals, e-signature and obligation tracking.',
      href: null,
      icon: <FileText className="w-6 h-6" strokeWidth={1.5} />,
      available: false,
    },
    {
      key: 'acr',
      name: 'Compliance Register',
      prefix: 'ACR',
      description: 'Regulatory obligation tracking, evidence uploads, escalations and the real-time RAG compliance dashboard.',
      href: null,
      icon: <ShieldCheck className="w-6 h-6" strokeWidth={1.5} />,
      available: false,
    },
  ];

  return (
    <AppLayout title="Legal Module">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-500">Legal Module</p>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">
            Legal &amp; Governance
          </h1>
          <p className="mt-2 text-sm text-text-secondary max-w-2xl">
            Contract Lifecycle Management, the Automated Compliance Register and Board Governance —
            built on The Circle&apos;s approval engine, audit trail and e-signature.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {subsystems.map((s) => {
            const inner = (
              <Card
                variant="elevated"
                padding="lg"
                className={`h-full flex flex-col ${s.available ? 'cursor-pointer' : 'opacity-70'}`}
              >
                <div className="flex items-center justify-between">
                  <div className="w-12 h-12 rounded-xl bg-primary-50 text-primary-600 flex items-center justify-center">
                    {s.icon}
                  </div>
                  <span className="text-[11px] font-semibold tracking-wider text-neutral-400">{s.prefix}</span>
                </div>
                <h2 className="mt-4 text-lg font-semibold text-text-primary">{s.name}</h2>
                <p className="mt-1.5 text-sm text-text-secondary flex-1">{s.description}</p>
                <div className="mt-4 flex items-center gap-1.5 text-sm font-medium">
                  {s.available ? (
                    <span className="inline-flex items-center gap-1.5 text-primary-600">
                      Open <ArrowRight className="w-4 h-4" />
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-neutral-400">
                      <Lock className="w-3.5 h-3.5" /> Coming soon
                    </span>
                  )}
                </div>
              </Card>
            );
            return s.available && s.href ? (
              <Link key={s.key} href={s.href} className="block">
                {inner}
              </Link>
            ) : (
              <div key={s.key}>{inner}</div>
            );
          })}
        </div>
      </div>
    </AppLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.id) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};
