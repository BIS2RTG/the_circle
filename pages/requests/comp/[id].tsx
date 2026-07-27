import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchHrimsEmployeeByEmail } from '@/lib/hrimsClient';
import { resolveOnBehalfProfile } from '@/lib/onBehalf';
import { formatDateTime } from '@/lib/formatDate';
import { useEffect, useRef, useState } from 'react';
import { AppLayout } from '../../../components/layout';
import { Card, Button, Input, RequestPreviewDocument, printPreviewDocument } from '../../../components/ui';
import ApprovalConfirmModal, { type ApprovalConfirmResult } from '../../../components/approvals/ApprovalConfirmModal';
import ElevationIndicator from '../../../components/approvals/ElevationIndicator';
import { useToast } from '../../../components/ui/ToastProvider';
import ConfirmDialog from '../../../components/ui/ConfirmDialog';
import SignatureSelector, { type SignatureSelection } from '../../../components/approvals/SignatureSelector';
import { ApprovedRequestPreviewInline, buildPreviewForRequest } from '../../../components/requests/ApprovedRequestPreview';
import { getApprovalRisk, type ApprovalRisk, type AuthenticationMethod } from '@/lib/approvalRisk';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import RedirectApprovalModal from '../../../components/RedirectApprovalModal';

interface RequestDetail {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'approved' | 'rejected' | 'in_review' | 'withdrawn' | 'draft' | 'cancelled';
    creator_id?: string;
    created_at: string;
    updated_at: string;
    current_step: number;
    total_steps: number;
    metadata?: Record<string, any>;
    creator: {
        id: string;
        display_name: string;
        email: string;
        profile_picture_url?: string;
        department_id?: string | null;
        job_title?: string | null;
    };
    current_approver?: {
        id: string;
        display_name: string;
        email: string;
    } | null;
    request_steps: {
        id: string;
        step_index: number;
        step_type: string;
        approver_role: string;
        status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'waiting';
        due_at?: string;
        created_at: string;
        first_viewed_at?: string | null;
        last_viewed_at?: string | null;
        approver?: {
            id: string;
            display_name: string;
            email: string;
            job_title?: string | null;
        } | null;
        approvals?: {
            id: string;
            decision: string;
            comment?: string;
            signed_at?: string;
            approver: {
                id: string;
                display_name: string;
                email: string;
            };
        }[];
    }[];
    documents?: {
        id: string;
        filename: string;
        storage_path: string;
        file_size?: number;
        mime_type?: string;
        created_at: string;
    }[];
}

const statusConfig: Record<string, { label: string; bg: string; text: string; icon: string }> = {
    pending: { label: 'Pending', bg: 'bg-amber-100/50', text: 'text-amber-700', icon: 'clock' },
    in_review: { label: 'In Review', bg: 'bg-[#F3EADC]/50', text: 'text-[#5E4426]', icon: 'refresh' },
    approved: { label: 'Approved', bg: 'bg-emerald-100/50', text: 'text-emerald-700', icon: 'check-circle' },
    rejected: { label: 'Rejected', bg: 'bg-rose-100/50', text: 'text-rose-700', icon: 'x-circle' },
    withdrawn: { label: 'Withdrawn', bg: 'bg-gray-100/50', text: 'text-gray-500', icon: 'minus-circle' },
    draft: { label: 'Draft', bg: 'bg-slate-100/50', text: 'text-slate-500', icon: 'document' },
};

const allocationLabels: Record<string, string> = {
    marketing_domestic: 'Marketing – Domestic',
    marketing_international: 'Marketing – International',
    administration: 'Administration',
    promotions: 'Promotions',
    personnel: 'Personnel',
};

const accommodationLabels: Record<string, string> = {
    accommodation_only: 'Accommodation Only (Bed only)',
    accommodation_and_breakfast: 'Bed & Breakfast',
    accommodation_and_meals: 'Accommodation & Meals',
    accommodation_meals_drink: 'Accommodation, Meals & Soft Drink',
    meals_all: 'Meals (Breakfast, Lunch and Dinner)',
    rainbow_delights: 'Rainbow Delights Meal',
    breakfast_only: 'Breakfast only',
    lunch_only: 'Lunch only',
    dinner_only: 'Dinner only',
};

interface ApproverInfo {
    id: string;
    display_name: string;
    email: string;
    profile_picture_url?: string;
    job_title?: string | null;
    status: 'pending' | 'approved' | 'rejected';
    signed_at?: string;
    comment?: string;
    first_viewed_at?: string | null;
    last_viewed_at?: string | null;
}

function getApproverIds(metadata: Record<string, any> | undefined): string[] {
    if (!metadata) return [];
    if (metadata.approvers) {
        if (typeof metadata.approvers === 'object' && !Array.isArray(metadata.approvers)) {
            return Object.values(metadata.approvers).filter(Boolean) as string[];
        }
        if (Array.isArray(metadata.approvers)) {
            return metadata.approvers;
        }
    }
    return [];
}

function ApprovalTimeline({ request, onRedirect, canRedirect }: { request: RequestDetail; onRedirect?: (step: any) => void; canRedirect?: boolean }) {
    const { data: session } = useSession();
    const currentUserId = session?.user?.id;
    
    // Check if current user is the requestor (creator of the request)
    const isRequestor = request.creator?.id === currentUserId;
    
    const [approvers, setApprovers] = useState<ApproverInfo[]>([]);
    const [loadingApprovers, setLoadingApprovers] = useState(true);

    useEffect(() => {
        async function fetchApprovers() {
            const approverIds: string[] = getApproverIds(request.metadata);

            if (approverIds.length === 0) {
                setLoadingApprovers(false);
                return;
            }

            try {
                const response = await fetch(`/api/users/by-ids?ids=${approverIds.join(',')}`);
                if (response.ok) {
                    const data = await response.json();
                    const users = data.users || [];

                    const approverInfos: ApproverInfo[] = approverIds.map((id, index) => {
                        const user = users.find((u: any) => u.id === id);
                        const step = request.request_steps?.find(s => s.approver?.id === id);
                        const approval = step?.approvals?.[0];

                        return {
                            id,
                            display_name: user?.display_name || `Approver ${index + 1}`,
                            email: user?.email || '',
                            profile_picture_url: user?.profile_picture_url,
                            job_title: user?.job_title || step?.approver?.job_title || null,
                            status: step?.status === 'approved' ? 'approved' :
                                step?.status === 'rejected' ? 'rejected' : 'pending',
                            signed_at: approval?.signed_at,
                            comment: approval?.comment,
                            first_viewed_at: step?.first_viewed_at || null,
                            last_viewed_at: step?.last_viewed_at || null,
                        };
                    });

                    setApprovers(approverInfos);
                }
            } catch (error) {
                console.error('Error fetching approvers:', error);
            } finally {
                setLoadingApprovers(false);
            }
        }

        fetchApprovers();
    }, [request]);

    if (loadingApprovers) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
            </div>
        );
    }

    if (approvers.length === 0) {
        return (
            <div className="bg-white rounded-2xl p-8 border border-gray-100 text-center shadow-sm">
                <p className="text-gray-500">No approvers assigned to this request.</p>
            </div>
        );
    }

    return (
        <div className="max-w-3xl">
            <div className="relative pl-6 sm:pl-10 space-y-8 pb-8">
                <div className="absolute left-[1.15rem] sm:left-[2.15rem] top-4 bottom-4 w-0.5 bg-gray-100" />

                {approvers.map((approver, index) => {
                    const isApproved = approver.status === 'approved';
                    const isRejected = approver.status === 'rejected';
                    const isPending = approver.status === 'pending';
                    const prevStepsApproved = index === 0 || approvers.slice(0, index).every(a => a.status === 'approved');
                    const isActive = isPending && prevStepsApproved;

                    return (
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.1 }}
                            key={approver.id}
                            className="relative"
                        >
                            <div className={`
                                absolute -left-[1.65rem] top-0 w-10 h-10 rounded-full border-4 flex items-center justify-center z-10 transition-all duration-300
                                ${isApproved
                                    ? 'bg-emerald-500 border-white shadow-lg shadow-emerald-200'
                                    : isRejected
                                        ? 'bg-rose-500 border-white shadow-lg shadow-rose-200'
                                        : isActive
                                            ? 'bg-white border-primary-500 text-primary-600 shadow-lg shadow-primary-100 scale-110'
                                            : 'bg-white border-gray-200 text-gray-400'
                                }
                            `}>
                                {isApproved ? (
                                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                ) : isRejected ? (
                                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                ) : (
                                    <span className="font-bold text-sm">{index + 1}</span>
                                )}
                            </div>

                            <div className={`
                                ml-4 p-5 rounded-2xl border transition-all duration-300 group
                                ${isActive
                                    ? 'bg-white border-primary-200 shadow-lg shadow-primary-50 ring-1 ring-primary-100'
                                    : 'bg-white border-gray-100 shadow-sm hover:shadow-md hover:border-gray-200'
                                }
                            `}>
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                    <div className="flex items-center gap-4">
                                        <div className="relative">
                                            <img
                                                src={approver.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(approver.display_name)}&background=random&size=48`}
                                                alt={approver.display_name}
                                                className="w-12 h-12 rounded-full object-cover border-2 border-white shadow-sm"
                                            />
                                        </div>
                                        <div>
                                            <h4 className={`font-bold text-lg ${isActive ? 'text-primary-700' : 'text-gray-900'}`}>
                                                {approver.display_name}
                                            </h4>
                                            {approver.job_title && (
                                                <p className="text-xs font-medium text-primary-700 mt-0.5">{approver.job_title}</p>
                                            )}
                                            <p className="text-sm text-gray-500">{approver.email}</p>
                                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                                                {approver.first_viewed_at ? (
                                                    <span
                                                        className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5"
                                                        title={`First opened ${formatDateTime(approver.first_viewed_at)}\nLast viewed ${approver.last_viewed_at ? formatDateTime(approver.last_viewed_at) : '—'}`}
                                                    >
                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                        </svg>
                                                        Opened {new Date(approver.first_viewed_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                                    </span>
                                                ) : isActive ? (
                                                    <span className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5">
                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                                        </svg>
                                                        Not reviewed yet
                                                    </span>
                                                ) : null}
                                            </div>
                                            {/* Show redirection / delegation indicator */}
                                            {(() => {
                                                const step = request.request_steps?.find(s => s.approver?.id === approver.id)
                                                    || request.request_steps?.find(s => (s as any).original_approver_id === approver.id);
                                                if (step && (step as any).is_redirected) {
                                                    const isDelegation = !!(step as any).delegation_id;
                                                    const reason = (step as any).redirect_reason;
                                                    return (
                                                        <div
                                                            className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200"
                                                            title={reason ? `Reason: ${reason}` : undefined}
                                                        >
                                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                                            </svg>
                                                            {isDelegation
                                                                ? `Delegated to ${(step as any).approver?.display_name || 'a delegate'}`
                                                                : `pp ${(step as any).redirect_job_title || 'Redirected'}`}
                                                        </div>
                                                    );
                                                }
                                                return null;
                                            })()}
                                        </div>
                                    </div>

                                    <div className="flex flex-col items-end gap-1">
                                        {isApproved ? (
                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                                                Approved
                                            </span>
                                        ) : isRejected ? (
                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-100">
                                                Rejected
                                            </span>
                                        ) : isActive ? (
                                            <div className="flex flex-col items-end gap-2">
                                                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary-50 text-primary-700 border border-primary-100 animate-pulse">
                                                    Awaiting Action
                                                </span>
                                            </div>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-50 text-gray-500 border border-gray-100">
                                                Pending
                                            </span>
                                        )}
                                        {approver.signed_at && (
                                            <span className="text-xs text-gray-400">
                                                {new Date(approver.signed_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {approver.comment && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        className="mt-4 pt-4 border-t border-gray-100"
                                    >
                                        <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 relative">
                                            <p className="italic">&ldquo;{approver.comment}&rdquo;</p>
                                        </div>
                                    </motion.div>
                                )}
                            </div>
                        </motion.div>
                    );
                })}
            </div>

          
        </div>
    );
}

interface CompHotelBookingDetailsPageProps {
  initialRequest: RequestDetail | null;
  initialError: string | null;
}

export const getServerSideProps: GetServerSideProps<CompHotelBookingDetailsPageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user) {
    // Preserve the deep link so post-sign-in (e.g. from an approval email) the
    // approver lands on this request, not the dashboard.
    const reqId = typeof context.query.id === 'string' ? context.query.id : '';
    const callbackUrl = encodeURIComponent(`/requests/comp/${reqId}`);
    return {
      redirect: {
        destination: `/?callbackUrl=${callbackUrl}`,
        permanent: false,
      },
    };
  }

  const user = session.user as any;
  const organizationId = user.org_id;
  const userId = user.id;
  const { id } = context.query;

  if (!id || typeof id !== 'string' || !organizationId) {
    return {
      props: {
        initialRequest: null,
        initialError: 'Invalid request',
      },
    };
  }

  try {
    const { data: request, error } = await supabaseAdmin
      .from('requests')
      .select(`
        id,
        title,
        description,
        status,
        metadata,
        created_at,
        updated_at,
        creator_id,
        creator:app_users!requests_creator_id_fkey (
          id,
          display_name,
          email,
          profile_picture_url,
          job_title
        ),
        request_steps (
          id,
          step_index,
          step_type,
          approver_role,
          approver_user_id,
          status,
          due_at,
          created_at,
          first_viewed_at,
          last_viewed_at,
          is_redirected,
          original_approver_id,
          redirected_by_id,
          redirected_at,
          redirect_reason,
          redirect_job_title,
          delegation_id,
          approver:app_users!request_steps_approver_user_id_fkey (
            id,
            display_name,
            email,
            profile_picture_url,
            job_title
          ),
          approvals (
            id,
            decision,
            comment,
            signed_at,
            signature_url,
            signature_reference,
            signature_type,
            authentication_method,
            approver:app_users!approvals_approver_id_fkey (
              id,
              display_name,
              email,
              profile_picture_url
            )
          )
        ),
        documents (
          id,
          filename,
          storage_path,
          file_size,
          mime_type,
          created_at
        )
      `)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) {
      return {
        props: {
          initialRequest: null,
          initialError: error.code === 'PGRST116' ? 'Request not found' : 'Failed to fetch request',
        },
      };
    }

    // Visibility check
    const isCreator = request.creator_id === userId;
    const watcherIds = request.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
      typeof w === 'string' ? w === userId : w?.id === userId
    );
    const userStep = request.request_steps?.find(
      (step: any) => step.approver_user_id === userId
    );
    const canApproverView = userStep && userStep.status !== 'waiting';

    if (!isCreator && !isWatcher && !canApproverView) {
      return {
        props: {
          initialRequest: null,
          initialError: userStep?.status === 'waiting' 
            ? 'This request is not yet ready for your review.' 
            : 'You do not have permission to view this request',
        },
      };
    }

    // Sort steps and calculate current step
    if (request.request_steps) {
      request.request_steps.sort((a: any, b: any) => a.step_index - b.step_index);
    }
    const currentStepIndex = request.request_steps?.findIndex((step: any) => step.status === 'pending') ?? -1;
    const currentStep = currentStepIndex >= 0 ? request.request_steps[currentStepIndex] : null;

    // Compute actual status
    const computeActualStatus = (dbStatus: string, steps: any[]) => {
      if (!steps || steps.length === 0) return dbStatus;
      if (steps.some((s: any) => s.status === 'rejected')) return 'rejected';
      if (steps.every((s: any) => s.status === 'approved')) return 'approved';
      if (steps.some((s: any) => s.status === 'pending' || s.status === 'waiting')) return 'pending';
      return dbStatus;
    };
    const actualStatus = computeActualStatus(request.status, request.request_steps);

    // Handle approver - could be array from query
    const rawApprover = currentStep?.approver;
    const currentApprover = Array.isArray(rawApprover) ? rawApprover[0] : rawApprover;

    // Normalize request_steps approvers (could be arrays from query)
    const normalizedSteps = request.request_steps?.map((step: any) => ({
      ...step,
      approver: Array.isArray(step.approver) ? step.approver[0] : step.approver,
    }));

    // Normalize creator
    let creator = Array.isArray(request.creator) ? request.creator[0] : request.creator;

    // If job_title is missing, try to fetch from HRIMS
    if (creator && !creator.job_title && creator.email) {
      try {
        const hrimsData = await fetchHrimsEmployeeByEmail(creator.email);
        if (hrimsData) {
          // Use position_title from organogram if available, otherwise use job_title from employee
          creator = {
            ...creator,
            job_title: hrimsData.position?.position_title || hrimsData.employee?.job_title || null,
          };
        }
      } catch (hrimsError) {
        console.log('Could not fetch HRIMS data for creator:', hrimsError);
      }
    }

    // When filed on behalf of someone, resolve THAT person as the requestor.
    const onBehalfProfile = await resolveOnBehalfProfile(request as any);

    const enrichedRequest = {
      ...request,
      creator,
      onBehalfProfile,
      status: actualStatus as RequestDetail['status'],
      current_step: currentStepIndex >= 0 ? currentStepIndex + 1 : request.request_steps?.length || 0,
      total_steps: request.request_steps?.length || 0,
      current_approver: currentApprover || null,
      request_steps: normalizedSteps,
    };

    return {
      props: {
        initialRequest: enrichedRequest,
        initialError: null,
      },
    };
  } catch (err: any) {
    // Log the real error server-side; never surface a raw message/stack to the UI.
    console.error('Comp request details getServerSideProps error:', err);
    return {
      props: {
        initialRequest: null,
        initialError: 'We couldn’t load this request. It may have been removed, or you may not have access to it.',
      },
    };
  }
};

export default function CompHotelBookingDetailsPage({ initialRequest, initialError }: CompHotelBookingDetailsPageProps) {
    const router = useRouter();
    const { id } = router.query;
    const { data: session, status } = useSession();
    const { addToast } = useToast();
    const [request, setRequest] = useState<RequestDetail | null>(initialRequest);
    const [loading, setLoading] = useState(!initialRequest);
    const [error, setError] = useState<string | null>(initialError);
    const [activeTab, setActiveTab] = useState<'preview' | 'details' | 'timeline' | 'documents'>('preview');
    const [publishing, setPublishing] = useState(false);
    const [publishError, setPublishError] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showPublishConfirm, setShowPublishConfirm] = useState(false);
    const [documents, setDocuments] = useState<any[]>([]);
    const [loadingDocuments, setLoadingDocuments] = useState(false);
    const [showReviewModal, setShowReviewModal] = useState(false);
    const [reviewComment, setReviewComment] = useState('');
    const [reviewProcessing, setReviewProcessing] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [userSignatureUrl, setUserSignatureUrl] = useState<string | null>(null);
    const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);
    const [pendingApprovalAction, setPendingApprovalAction] = useState<'approve' | 'reject' | null>(null);
    const [approvalRisk, setApprovalRisk] = useState<ApprovalRisk>('low');
    const [approvalRiskReasons, setApprovalRiskReasons] = useState<string[]>([]);
    const [hasBiometric, setHasBiometric] = useState(false);
    const [signatureSelection, setSignatureSelection] = useState<SignatureSelection>({ type: 'saved' });
    const [authClearedFor, setAuthClearedFor] = useState<'none' | 'session' | 'microsoft_mfa' | 'biometric'>('none');
    const [showRejectConfirm, setShowRejectConfirm] = useState(false);
    const [showRedirectModal, setShowRedirectModal] = useState(false);
    const [redirectStepInfo, setRedirectStepInfo] = useState<{ stepId: string; stepIndex: number; approverRole?: string; currentApproverName?: string } | null>(null);
    const [redirecting, setRedirecting] = useState(false);
    const [showCancelModal, setShowCancelModal] = useState(false);
    const [cancelReason, setCancelReason] = useState('');
    const [cancelling, setCancelling] = useState(false);
    const [unsubmitting, setUnsubmitting] = useState(false);

    const currentUserId = (session?.user as any)?.id;
    // Authoritative creator_id (always present) with the embedded object as a
    // fallback — relying only on the embed made the creator's action buttons
    // (Unsubmit & Edit, Cancel, Delete) silently disappear.
    const creatorId = (request as any)?.creator_id
        || (Array.isArray(request?.creator) ? (request?.creator as any)[0]?.id : request?.creator?.id);
    const isCreator = !!currentUserId && creatorId === currentUserId;
    const isDraft = request?.status === 'draft';
    const canPublish = isCreator && isDraft;
    const canDelete = isCreator && request?.status !== 'approved';
    
    // Check if current user is a watcher
    const watcherIds = request?.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
        typeof w === 'string' ? w === currentUserId : w?.id === currentUserId
    );

    const pendingStep = request?.request_steps?.find(
        s => s.approver?.id === currentUserId && s.status === 'pending'
    );

    const waitingStepThatShouldBePending = (() => {
        if (!request?.request_steps) return null;
        const sortedSteps = [...request.request_steps].sort((a, b) => a.step_index - b.step_index);
        for (const step of sortedSteps) {
            if (step.status === 'approved') continue;
            if (step.status === 'rejected') return null;
            if (step.approver?.id === currentUserId && (step.status === 'pending' || step.status === 'waiting')) {
                return step;
            }
            return null;
        }
        return null;
    })();

    const effectivePendingStep = pendingStep || waitingStepThatShouldBePending;
    const isCurrentApprover = !!effectivePendingStep;

    // Universal request actions — parity with /requests/[id]. Cancel is available
    // to the requester or any approver at any active stage; Unsubmit & Edit pulls
    // a still-pending request back to a draft while NO approver has acted; Reopen
    // revives a cancelled request that wasn't already fully approved.
    const isApproverOnRequest = (request?.request_steps || []).some(s => s.approver?.id === currentUserId);
    const effectiveStatus = () => {
        // computeActualStatus lives in getServerSideProps scope; recompute the
        // same way from steps so terminal states win over stale step data.
        const st = request?.status;
        if (!request) return st;
        if (['cancelled', 'withdrawn', 'draft', 'expired'].includes(st || '')) return st;
        const steps = request.request_steps || [];
        if (steps.length === 0) return st;
        if (steps.some(s => s.status === 'rejected')) return 'rejected';
        if (steps.every(s => s.status === 'approved')) return 'approved';
        if (steps.some(s => s.status === 'pending' || s.status === 'waiting')) return 'pending';
        return st;
    };
    const statusNow = effectiveStatus();
    const noApproverActed = !(request?.request_steps || []).some(
        s => s.status === 'approved' || s.status === 'rejected'
    );
    const canCancel = (isCreator || isApproverOnRequest)
        && !!request && !['cancelled', 'withdrawn', 'draft'].includes(statusNow || '');
    const canUnsubmit = isCreator && statusNow === 'pending' && noApproverActed;
    const canRevive = isCreator && statusNow === 'cancelled'
        && ((request?.metadata as any)?.cancellation?.previousStatus !== 'approved');

    // Map a comp/hotel request type to its editable form route.
    const compEditRoute = (): string => {
        const t = request?.metadata?.type || (request as any)?.type;
        if (t === 'hotel_booking') return 'hotel-booking';
        if (t === 'external_hotel_booking') return 'external-hotel-booking';
        return 'voucher';
    };

    const handleCancelRequest = async () => {
        if (!id || !canCancel) return;
        const reason = cancelReason.trim();
        if (!reason) {
            addToast({ type: 'error', title: 'Reason required', message: 'Please provide a reason for cancelling.' });
            return;
        }
        setCancelling(true);
        try {
            const response = await fetch(`/api/requests/${id}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to cancel request');
            addToast({ type: 'success', title: 'Request cancelled', message: 'The request has been cancelled and the other parties notified.' });
            const refresh = await fetch(`/api/requests/${id}`);
            if (refresh.ok) setRequest((await refresh.json()).request);
            setShowCancelModal(false);
            setCancelReason('');
        } catch (err: any) {
            console.error('Error cancelling request:', err);
            addToast({ type: 'error', title: 'Cancellation failed', message: err.message || 'Failed to cancel request' });
        } finally {
            setCancelling(false);
        }
    };

    const handleUnsubmit = async () => {
        if (!id || (!canUnsubmit && !canRevive)) return;
        setUnsubmitting(true);
        try {
            const response = await fetch(`/api/requests/${id}/unsubmit`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to unsubmit request');
            addToast({
                type: 'success',
                title: canRevive ? 'Request reopened' : 'Request unsubmitted',
                message: 'Amend your request, then submit it again for approval.',
            });
            router.push(`/requests/new/${compEditRoute()}?edit=${id}`);
        } catch (err: any) {
            console.error('Error unsubmitting request:', err);
            addToast({ type: 'error', title: 'Unsubmit failed', message: err.message || 'Failed to unsubmit request' });
        } finally {
            setUnsubmitting(false);
        }
    };

    // Record an "approver opened the request" event so the timeline can show
    // whether the assigned approver has actually looked at the request yet.
    // No-op for non-approvers — the API handles that branch.
    useEffect(() => {
        if (!id || typeof id !== 'string' || !currentUserId) return;
        const isApprover = request?.request_steps?.some(s => s.approver?.id === currentUserId);
        if (!isApprover) return;
        fetch(`/api/requests/${id}/view`, { method: 'POST' }).catch(() => { /* silent */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, currentUserId, request?.id]);
    
    // Approvers can edit (navigate to edit form)
    const canApproverEdit = isCurrentApprover;

    const computeActualStatus = (): string | undefined => {
        if (!request) return undefined;
        const steps = request.request_steps || [];
        if (steps.length === 0) return request.status;
        if (steps.some(s => s.status === 'rejected')) return 'rejected';
        if (steps.every(s => s.status === 'approved')) return 'approved';
        if (steps.some(s => s.status === 'pending' || s.status === 'waiting')) return 'pending';
        return request.status;
    };
    const actualStatus = computeActualStatus();

    useEffect(() => {
        if (showReviewModal && currentUserId) {
            fetch('/api/user/signature')
                .then(res => res.json())
                .then(data => {
                    if (data.signature_url) {
                        setUserSignatureUrl(data.signature_url);
                    }
                })
                .catch(err => console.error('Error fetching signature:', err));
        }
    }, [showReviewModal, currentUserId]);

    // Risk + elevation gate for the review modal — same logic as /requests/[id].tsx
    useEffect(() => {
        if (!showReviewModal || !request) {
            setAuthClearedFor('none');
            return;
        }
        const steps = request.request_steps || [];
        const stepIdx = effectivePendingStep?.step_index ?? 0;
        const evalResult = getApprovalRisk({
            value: request.metadata?.amount ?? request.metadata?.total_amount ?? null,
            workflowCategory: request.metadata?.workflow_category || request.metadata?.category || null,
            requestType: request.metadata?.type || request.metadata?.requestType || null,
            currentStepIndex: stepIdx,
            totalSteps: steps.length,
            formData: request.metadata?.formData || request.metadata?.form_data || null,
        });
        setApprovalRisk(evalResult.risk);
        setApprovalRiskReasons(evalResult.reasons);
        if (evalResult.risk === 'low') {
            setAuthClearedFor('session');
            return;
        }
        let cancelled = false;
        const requiredRank = evalResult.risk === 'high' ? 2 : 1;
        const rankMethod = (m: string | null | undefined) =>
            m === 'biometric' ? 2 : m === 'microsoft_mfa' ? 1 : 0;
        const refresh = () => {
            fetch('/api/auth/elevation')
                .then(r => r.ok ? r.json() : null)
                .then((data) => {
                    if (cancelled) return;
                    const provides = rankMethod(data?.method);
                    const satisfies = data?.elevated && (
                        provides >= requiredRank ||
                        (requiredRank === 2 && provides >= 1)
                    );
                    if (satisfies) {
                        setAuthClearedFor(data.method);
                    } else {
                        setAuthClearedFor('none');
                    }
                })
                .catch(() => { if (!cancelled) setAuthClearedFor('none'); });
        };
        refresh();
        const onUpdate = () => refresh();
        window.addEventListener('elevation-updated', onUpdate);
        return () => {
            cancelled = true;
            window.removeEventListener('elevation-updated', onUpdate);
        };
    }, [showReviewModal, request, effectivePendingStep]);

    const needsAuthFirst = showReviewModal && approvalRisk !== 'low' && authClearedFor === 'none';

    const handleApprovalAction = async (action: 'approve' | 'reject') => {
        if (!id || !effectivePendingStep) return;

        if (action === 'reject' && !reviewComment.trim()) {
            setReviewError('Please provide a reason for rejection');
            return;
        }

        // Block both approve AND reject until the user passes the required
        // authentication ceremony.
        if (needsAuthFirst) {
            setPendingApprovalAction(action);
            setShowApprovalConfirm(true);
            setReviewError(null);
            return;
        }

        if (action === 'approve') {
            if (signatureSelection.type === 'saved' && !userSignatureUrl) {
                setReviewError('You need to set up your signature before approving. Go to Profile > Signature.');
                return;
            }
            if (signatureSelection.type === 'manual' && !signatureSelection.data) {
                setReviewError('Please draw your signature before approving.');
                return;
            }
        }

        // Evaluate risk client-side (server re-evaluates authoritatively)
        const steps = request?.request_steps || [];
        const currentStepIndex = effectivePendingStep.step_index ?? 0;
        const riskEval = getApprovalRisk({
            value: request?.metadata?.amount ?? request?.metadata?.total_amount ?? null,
            workflowCategory: request?.metadata?.workflow_category || request?.metadata?.category || null,
            requestType: request?.metadata?.type || request?.metadata?.requestType || null,
            currentStepIndex,
            totalSteps: steps.length,
            formData: request?.metadata?.formData || request?.metadata?.form_data || null,
        });

        setApprovalRisk(riskEval.risk);
        setApprovalRiskReasons(riskEval.reasons);

        if (riskEval.risk === 'high') {
            try {
                const credRes = await fetch('/api/webauthn/credentials');
                if (credRes.ok) {
                    const credData = await credRes.json();
                    setHasBiometric((credData.credentials || []).some((c: any) => c.is_active));
                }
            } catch { /* proceed without biometric info */ }
        }

        setPendingApprovalAction(action);
        setShowApprovalConfirm(true);
    };

    const handleApprovalConfirmed = async (result: ApprovalConfirmResult) => {
        if (!id || !effectivePendingStep || !pendingApprovalAction) return;

        if (result.elevation && !result.elevation.reused) {
            const minutes = Math.max(1, Math.round((result.elevation.expiresAt - Date.now()) / 60000));
            addToast({
                type: 'success',
                title: `You are verified for ${minutes} minute${minutes === 1 ? '' : 's'}`,
                message: `You can approve without re-authentication.`,
                duration: 8000,
            });
            try { window.dispatchEvent(new Event('elevation-updated')); } catch { /* SSR */ }
        }

        // If the ceremony was triggered to clear the auth gate, close the
        // auth modal and let the user finish in the review modal — DO NOT
        // submit yet. Applies to both approve and reject.
        if (needsAuthFirst) {
            setShowApprovalConfirm(false);
            setAuthClearedFor(result.authMethod);
            return;
        }

        setReviewProcessing(true);
        setReviewError(null);

        try {
            const body: Record<string, any> = {
                requestId: id,
                stepId: effectivePendingStep.id,
                action: pendingApprovalAction,
                comment: reviewComment || undefined,
                stepUpToken: result.stepUpToken,
                authMethod: result.authMethod,
                signatureType: signatureSelection.type,
                deviceInfo: {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    language: navigator.language,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
            };

            if (signatureSelection.type === 'manual' && signatureSelection.data) {
                body.signatureData = signatureSelection.data;
            }

            const response = await fetch('/api/approvals/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `Failed to ${pendingApprovalAction} request`);
            }

            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }

            setShowReviewModal(false);
            setShowApprovalConfirm(false);
            setReviewComment('');
            setPendingApprovalAction(null);
            setSignatureSelection({ type: 'saved' });
        } catch (err: any) {
            setReviewError(err.message || `Failed to ${pendingApprovalAction} request`);
            setShowApprovalConfirm(false);
        } finally {
            setReviewProcessing(false);
        }
    };

    const handleApprovalConfirmCancel = () => {
        setShowApprovalConfirm(false);
        setPendingApprovalAction(null);
    };

    // Check if user can redirect approvals (creator or any approver)
    const canRedirectApprovals = (() => {
        if (!request || request.status !== 'pending') return false;
        if (isCreator) return true;
        // Check if user is any approver on this request
        return request.request_steps?.some(s => s.approver?.id === currentUserId);
    })();

    const handleOpenRedirectModal = (step: any) => {
        setRedirectStepInfo({
            stepId: step.id,
            stepIndex: step.step_index,
            approverRole: step.approver_role,
            currentApproverName: step.approver?.display_name,
        });
        setShowRedirectModal(true);
    };

    const handleRedirectApproval = async (data: { newApproverId: string; reason: string; jobTitle: string }) => {
        if (!redirectStepInfo || !id) return;

        setRedirecting(true);
        try {
            const response = await fetch('/api/approvals/redirect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requestId: id,
                    stepId: redirectStepInfo.stepId,
                    newApproverId: data.newApproverId,
                    reason: data.reason,
                    jobTitle: data.jobTitle,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to redirect approval');
            }

            // Refresh the request data
            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }

            setShowRedirectModal(false);
            setRedirectStepInfo(null);
        } catch (err: any) {
            throw err;
        } finally {
            setRedirecting(false);
        }
    };

    const handlePublish = async () => {
        if (!id || !canPublish) return;

        setPublishing(true);
        setPublishError(null);

        try {
            const response = await fetch(`/api/requests/${id}/publish`, {
                method: 'POST',
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to publish request');
            }

            const refreshResponse = await fetch(`/api/requests/${id}`);
            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                setRequest(refreshData.request);
            }

            router.push('/requests/my-requests');
        } catch (err: any) {
            setPublishError(err.message || 'Failed to publish request');
        } finally {
            setPublishing(false);
        }
    };

    const handleDelete = async () => {
        if (!id || !canDelete) return;

        setDeleting(true);
        setPublishError(null);

        try {
            const response = await fetch(`/api/requests/${id}`, {
                method: 'DELETE',
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to delete request');
            }

            router.push('/requests/my-requests');
        } catch (err: any) {
            setPublishError(err.message || 'Failed to delete request');
            setShowDeleteConfirm(false);
        } finally {
            setDeleting(false);
        }
    };

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

    useEffect(() => {
        async function fetchRequestDetails() {
            if (!id || status !== 'authenticated') return;
            // Skip if we already have initial data and id hasn't changed
            if (initialRequest && initialRequest.id === id) {
                setLoading(false);
                return;
            }

            setLoading(true);
            try {
                const response = await fetch(`/api/requests/${id}`);

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'Failed to fetch request');
                }

                const data = await response.json();
                setRequest(data.request);
                setError(null);
            } catch (err: any) {
                setError(err.message || 'Failed to load request details.');
            } finally {
                setLoading(false);
            }
        }

        fetchRequestDetails();
    }, [id, status, initialRequest]);

    const fetchDocuments = async () => {
        if (!id) return;

        setLoadingDocuments(true);
        try {
            const response = await fetch(`/api/requests/${id}/documents`);
            if (response.ok) {
                const data = await response.json();
                setDocuments(data.documents || []);
            }
        } catch (err) {
            console.error('Error fetching documents:', err);
        } finally {
            setLoadingDocuments(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'documents' && id) {
            fetchDocuments();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, activeTab]);

    // Download as PDF by printing the same document the Preview tab renders —
    // so a comp combined with a travel authorisation prints as two pages (the
    // travel section carries pageBreakBefore), followed by the supporting
    // documents list. Uses the browser's "Save as PDF".
    const pdfDocRef = useRef<HTMLDivElement>(null);
    const pdfPreview = request ? buildPreviewForRequest(request) : null;
    const handleDownloadPdf = () => {
        if (pdfDocRef.current && pdfPreview) {
            printPreviewDocument(pdfDocRef.current, pdfPreview.title);
        } else if (id) {
            window.open(`/api/requests/${id}/pdf`, '_blank');
        }
    };

    const handleDownloadVoucher = () => {
        if (!id) return;
        window.open(`/api/requests/${id}/voucher-pdf`, '_blank');
    };

    if (status === 'loading' || loading) {
        return (
            <AppLayout title="Request Details">
                <div className="flex flex-col items-center justify-center min-h-[60vh]">
                    <div className="relative w-16 h-16">
                        <div className="absolute top-0 left-0 w-full h-full border-4 border-gray-200 rounded-full"></div>
                        <div className="absolute top-0 left-0 w-full h-full border-4 border-primary-500 rounded-full border-t-transparent animate-spin"></div>
                    </div>
                    <p className="mt-4 text-gray-400 font-medium animate-pulse">Loading request details...</p>
                </div>
            </AppLayout>
        );
    }

    if (error || !request) {
        return (
            <AppLayout title="Error">
                <div className="p-6 max-w-4xl mx-auto">
                    <Card className="text-center py-16 px-8">
                        <div className="w-20 h-20 bg-danger-50 rounded-full flex items-center justify-center mx-auto mb-6">
                            <svg className="w-10 h-10 text-danger-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                        </div>
                        <h3 className="text-2xl font-bold text-text-primary mb-2">Request Not Found</h3>
                        <p className="text-text-secondary max-w-md mx-auto mb-8">{error || "The request does not exist or you do not have permission to view it."}</p>
                        <Button variant="primary" onClick={() => router.push('/requests/my-requests')}>
                            Back to My Requests
                        </Button>
                    </Card>
                </div>
            </AppLayout>
        );
    }

    const statusInfo = statusConfig[actualStatus || request.status] || statusConfig.pending;
    // Older external-hotel-booking submissions nest fields under
    // metadata.hotelBooking — flatten that into the top level so the same
    // detail tab renders correctly for every comp/voucher/booking variant.
    const rawMetadata = request.metadata || {};
    const metadata: Record<string, any> = rawMetadata.hotelBooking && typeof rawMetadata.hotelBooking === 'object'
        ? { ...rawMetadata.hotelBooking, ...rawMetadata, ...rawMetadata.hotelBooking }
        : rawMetadata;
    // External hotel bookings don't use the multi-unit picker — they store
    // a single hotelUnit + room/night fields flat on metadata. Project that
    // into a one-element selectedBusinessUnits so the same card renders.
    const selectedBusinessUnits = (() => {
        if (Array.isArray(metadata.selectedBusinessUnits) && metadata.selectedBusinessUnits.length > 0) {
            return metadata.selectedBusinessUnits;
        }
        if (metadata.hotelUnit || metadata.numberOfRooms || metadata.numberOfNights || metadata.arrivalDate) {
            return [{
                id: 'single',
                name: metadata.hotelUnit || 'Hotel',
                accommodationType: metadata.accommodationType,
                voucherValidityPeriod: metadata.arrivalDate && metadata.departureDate
                    ? `${metadata.arrivalDate} → ${metadata.departureDate}`
                    : metadata.voucherValidityPeriod,
                numberOfPeople: metadata.numberOfPeople,
                numberOfRooms: metadata.numberOfNights || metadata.numberOfRooms,
                roomType: metadata.roomType,
                specialArrangements: metadata.specialArrangements,
                numberOfMeals: metadata.numberOfMeals,
                mealPeopleCount: metadata.mealPeopleCount,
                bookingMade: metadata.telBookingMade || metadata.bookingMade,
            }];
        }
        return [];
    })();
    const travelDocument = metadata.travelDocument;
    const hasTravelDocument = metadata.processTravelDocument && travelDocument;
    const supportingDocuments = metadata.supportingDocuments || [];

    return (
        <AppLayout title={`Request #${request.id.substring(0, 8)}`}>
            {/* Risk-Based Approval Verification Modal */}
            <ApprovalConfirmModal
                isOpen={showApprovalConfirm}
                risk={approvalRisk}
                action={pendingApprovalAction || 'approve'}
                requestId={id as string}
                stepId={effectivePendingStep?.id || ''}
                hasBiometric={hasBiometric}
                riskReasons={approvalRiskReasons}
                onConfirmed={handleApprovalConfirmed}
                onCancel={handleApprovalConfirmCancel}
                busy={reviewProcessing}
            />
            <ElevationIndicator />

            <ConfirmDialog
                isOpen={showRejectConfirm}
                title="Reject this request?"
                message={
                    <span>
                        Are you sure you want to reject &ldquo;<span className="font-medium text-gray-900">{request?.title}</span>&rdquo;?
                        The requester will be notified and the workflow will not advance.
                    </span>
                }
                confirmLabel="Reject"
                cancelLabel="Go back"
                busy={reviewProcessing}
                variant="danger"
                onCancel={() => setShowRejectConfirm(false)}
                onConfirm={async () => {
                    setShowRejectConfirm(false);
                    await handleApprovalAction('reject');
                }}
            />

            {/* Redirect Approval Modal */}
            <RedirectApprovalModal
                isOpen={showRedirectModal}
                onClose={() => { setShowRedirectModal(false); setRedirectStepInfo(null); }}
                onSubmit={handleRedirectApproval}
                stepInfo={redirectStepInfo ? {
                    stepIndex: redirectStepInfo.stepIndex,
                    approverRole: redirectStepInfo.approverRole,
                    currentApproverName: redirectStepInfo.currentApproverName,
                } : undefined}
                requestTitle={request?.title}
            />

            {/* Off-screen document used by "Download PDF" — printPreviewDocument
                clones this node's HTML into a print window (2 pages for a comp +
                travel booking, plus the supporting-documents list). */}
            {pdfPreview && (
                <div aria-hidden="true" style={{ position: 'absolute', left: -99999, top: 0, width: 800 }}>
                    <RequestPreviewDocument
                        ref={pdfDocRef}
                        title={pdfPreview.title}
                        subtitle={pdfPreview.subtitle}
                        sections={pdfPreview.sections}
                        documentHeader={pdfPreview.documentHeader}
                    />
                </div>
            )}

            {/* Cancel Request Modal — requires a reason */}
            {showCancelModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 rounded-full bg-danger-100 flex items-center justify-center flex-shrink-0">
                                <svg className="w-6 h-6 text-danger-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                </svg>
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-text-primary">Cancel Request</h3>
                                <p className="text-sm text-text-secondary">The record is kept; the request is marked cancelled</p>
                            </div>
                        </div>
                        <p className="text-text-secondary mb-3 text-sm">
                            Cancelling &ldquo;<span className="font-medium text-text-primary">{request?.title}</span>&rdquo;
                            {statusNow === 'approved' ? ' (currently approved)' : ''}. The requester and approvers
                            will be notified. Please explain why this request is being cancelled.
                        </p>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Reason for cancellation <span className="text-danger-600">*</span>
                        </label>
                        <textarea
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                            placeholder="e.g. Guest cancelled / duplicate request / no longer required…"
                            className="w-full px-4 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-danger-500 focus:border-transparent min-h-[100px] mb-5"
                            autoFocus
                        />
                        <div className="flex gap-3 justify-end">
                            <Button variant="outline" onClick={() => { setShowCancelModal(false); setCancelReason(''); }} disabled={cancelling}>
                                Keep Request
                            </Button>
                            <Button variant="danger" onClick={handleCancelRequest} disabled={cancelling || !cancelReason.trim()} isLoading={cancelling}>
                                {cancelling ? 'Cancelling…' : 'Cancel Request'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-[1400px] mx-auto p-4 sm:p-6 lg:p-8 space-y-6">

                {publishError && (
                    <Card className="bg-danger-50 border-danger-200 !p-4">
                        <div className="flex items-center gap-3">
                            <svg className="w-5 h-5 text-danger-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="text-danger-700 text-sm">{publishError}</p>
                            <button onClick={() => setPublishError(null)} className="ml-auto text-danger-500 hover:text-danger-700">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </Card>
                )}

                {/* Watcher indicator banner */}
                {isWatcher && !isCreator && !isCurrentApprover && (
                    <Card className="bg-[#F3EADC] border-[#C9B896] !p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[#F3EADC] flex items-center justify-center flex-shrink-0">
                                <svg className="w-4 h-4 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-[#3F2D19] text-sm font-medium">You are viewing this request as a Watcher</p>
                                <p className="text-[#9A7545] text-xs mt-0.5">You can view details and download the voucher once approved, but cannot make changes.</p>
                            </div>
                        </div>
                    </Card>
                )}

                <nav className="flex items-center text-sm text-text-secondary mb-2">
                    {/* Approvers go back to Approval Tasks; the requester (and
                        everyone else) go to My Requests. */}
                    <Link
                        href={isApproverOnRequest && !isCreator ? '/approvals' : '/requests/my-requests'}
                        className="hover:text-primary-600 transition-colors flex items-center gap-1"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                        </svg>
                        {isApproverOnRequest && !isCreator ? 'Back to Approval Tasks' : 'Back to My Requests'}
                    </Link>
                    <span className="mx-2 text-gray-300">/</span>
                    <span className="text-text-primary font-medium truncate max-w-xs">{request.title}</span>
                </nav>

                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-3">
                            <span className={`px-3 py-1 rounded-full text-sm font-semibold flex items-center gap-1.5 ${statusInfo.bg} ${statusInfo.text}`}>
                                <div className="w-2 h-2 rounded-full bg-current" />
                                {statusInfo.label}
                            </span>
                            <span className="text-text-secondary text-sm">#{request.id.substring(0, 8)}</span>
                            {metadata?.referenceCode ? (
                                <span className="font-mono text-xs font-semibold text-gray-600 bg-gray-100 px-2.5 py-1 rounded border border-gray-200 tracking-wider">
                                    {metadata.referenceCode}
                                </span>
                            ) : null}
                        </div>
                        <h1 className="text-3xl font-bold text-text-primary font-heading leading-tight mb-2">
                            {request.title}
                        </h1>
                        {/* Guest name — the requestor is normally the guest, so fall
                            back to the creator's name when none was entered. */}
                        <p className="text-primary-600 font-medium text-lg mt-1">
                            {metadata.guestNames
                                || [metadata.guestTitle, metadata.guestFirstName].filter(Boolean).join(' ')
                                || request.creator?.display_name
                                || '—'}
                        </p>
                        <div className="text-text-secondary text-lg leading-relaxed max-w-3xl">
                            {request.description}
                        </div>
                    </div>

                    <div className="flex gap-3 flex-shrink-0">
                        {canDelete && (
                            <Button variant="outline" className="gap-2 bg-white text-danger-600 border-danger-200 hover:bg-danger-50" onClick={() => setShowDeleteConfirm(true)}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                                Delete
                            </Button>
                        )}
{isDraft ? (
                            <Button 
                                variant="outline" 
                                className="gap-2 bg-white text-primary-600 border-primary-200 hover:bg-primary-50" 
                                onClick={() => {
                                    const reqType = request?.metadata?.type || (request as any)?.type;
                                    if (reqType === 'hotel_booking') {
                                        router.push(`/requests/new/hotel-booking?edit=${id}`);
                                    } else if (reqType === 'external_hotel_booking') {
                                        router.push(`/requests/new/external-hotel-booking?edit=${id}`);
                                    } else {
                                        router.push(`/requests/new/voucher?edit=${id}`);
                                    }
                                }}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                                Edit Draft
                            </Button>
                        ) : (
                            <>
                                <Button variant="outline" className="gap-2 bg-white" onClick={handleDownloadPdf}>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                    </svg>
                                    PDF
                                </Button>
                                {actualStatus === 'approved' && request.metadata?.type === 'voucher_request' && (
                                    <Button variant="primary" className="gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 shadow-lg shadow-amber-500/20" onClick={handleDownloadVoucher}>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                                        </svg>
                                        Generate Voucher
                                    </Button>
                                )}
                            </>
                        )}
                        {canPublish && (
                            <Button variant="primary" className="gap-2 shadow-lg shadow-primary-500/20" onClick={() => setShowPublishConfirm(true)} disabled={publishing} isLoading={publishing}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                </svg>
                                {publishing ? 'Publishing...' : 'Publish Request'}
                            </Button>
                        )}
                        {isCurrentApprover && (
                            <Button variant="primary" className="gap-2 shadow-lg shadow-primary-500/20" onClick={() => setShowReviewModal(true)}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                Review Request
                            </Button>
                        )}
                        {/* Unsubmit & Edit — creator only, while pending and no approver has acted */}
                        {canUnsubmit && (
                            <Button variant="outline" className="gap-2 bg-white text-text-secondary border-gray-200 hover:bg-gray-50" onClick={handleUnsubmit} disabled={unsubmitting} isLoading={unsubmitting}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                                {unsubmitting ? 'Unsubmitting…' : 'Unsubmit & Edit'}
                            </Button>
                        )}
                        {/* Reopen & Edit — creator only, revive a cancelled request */}
                        {canRevive && (
                            <Button variant="outline" className="gap-2 bg-white text-primary-700 border-primary-200 hover:bg-primary-50" onClick={handleUnsubmit} disabled={unsubmitting} isLoading={unsubmitting}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                {unsubmitting ? 'Reopening…' : 'Reopen & Edit'}
                            </Button>
                        )}
                        {/* Cancel Request — requester or approver, at any active stage */}
                        {canCancel && (
                            <Button variant="outline" className="gap-2 bg-white text-danger-600 border-danger-200 hover:bg-danger-50" onClick={() => { setCancelReason(''); setShowCancelModal(true); }}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                </svg>
                                Cancel Request
                            </Button>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2 space-y-6">
                        <div className="border-b border-gray-200">
                            <div className="flex gap-8">
                                {(['preview', 'details', 'timeline', 'documents'] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`pb-4 px-1 text-sm font-medium border-b-2 transition-all capitalize ${activeTab === tab ? 'border-primary-500 text-primary-600' : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300'}`}
                                    >
                                        {tab}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="min-h-[400px]">
                            {activeTab === 'preview' && (
                                <ApprovedRequestPreviewInline request={request} />
                            )}
                            {activeTab === 'details' && (
                                <div className="space-y-6">
                                    {/* Guest Information Card */}
                                    <Card className="!p-0 overflow-hidden border-primary-100 shadow-sm bg-gradient-to-br from-primary-50 via-white to-accent/5">
                                        <div className="p-6">
                                            <div className="flex items-start justify-between">
                                                <div>
                                                    <span className="text-xs font-semibold text-primary-600 uppercase tracking-wider">Guest Information</span>
                                                    <h2 className="text-2xl font-bold text-text-primary mt-1 font-heading">
                                                        {metadata.guestNames || (metadata.guestTitle && metadata.guestFirstName ? `${metadata.guestTitle} ${metadata.guestFirstName}` : request.creator?.display_name || (metadata.voucherNumber ? `Voucher #${metadata.voucherNumber}` : `Request #${request.id.substring(0, 8)}`))}
                                                    </h2>
                                                    <div className="flex items-center gap-2 mt-2">
                                                        {metadata.isExternalGuest ? (
                                                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                                                </svg>
                                                                External Guest
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                                                </svg>
                                                                Staff Member
                                                            </span>
                                                        )}
                                                        {metadata.showNameOnVoucher !== false ? (
                                                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-[#F3EADC] text-[#5E4426]">
                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                                </svg>
                                                                Name Visible on Voucher
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                                                </svg>
                                                                Name Hidden on Voucher
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    {request.metadata?.type === 'voucher_request' && (
                                                        <div className="mb-3">
                                                            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Voucher Number</span>
                                                            <div className="text-lg font-bold font-mono tracking-wider text-primary-600 mt-1">
                                                                {metadata.voucherNumber || 'N/A'}
                                                            </div>
                                                        </div>
                                                    )}
                                                    <div>
                                                        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Charge To</span>
                                                        <div className="text-sm font-semibold text-text-primary mt-1">
                                                            {allocationLabels[metadata.allocationType] || metadata.allocationType || 'N/A'}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </Card>

                                    {/* Booking Details Card */}
                                    <Card className="!p-0 overflow-hidden border-gray-200 shadow-sm">
                                        <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-100">
                                            <h3 className="font-semibold text-text-primary font-heading">Booking Details</h3>
                                        </div>
                                        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                                            {metadata.percentageDiscount && (
                                                <div className="group">
                                                    <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1 block">Percentage Discount</label>
                                                    <div className="text-text-primary font-medium text-base border-b border-gray-100 pb-2">{metadata.percentageDiscount}%</div>
                                                </div>
                                            )}
                                            <div className="group md:col-span-2">
                                                <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1 block">Reason for Complimentary</label>
                                                <div className="text-text-primary font-medium text-base border-b border-gray-100 pb-2 whitespace-pre-wrap">{metadata.reason || 'N/A'}</div>
                                            </div>
                                        </div>
                                    </Card>

                                    {/* Business Units Card */}
                                    {selectedBusinessUnits.length > 0 && (
                                        <Card className="!p-0 overflow-hidden border-gray-200 shadow-sm">
                                            <div className="bg-emerald-50/50 px-6 py-4 border-b border-emerald-100 flex items-center justify-between">
                                                <h3 className="font-semibold text-emerald-800 flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                                                    </svg>
                                                    Business Units
                                                </h3>
                                                <span className="text-sm text-emerald-600 font-medium">{selectedBusinessUnits.length} selected</span>
                                            </div>
                                            <div className="p-4 space-y-4">
                                                {selectedBusinessUnits.map((unit: any, index: number) => (
                                                    <div key={unit.id || index} className="p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 transition-colors">
                                                        <div className="flex items-center justify-between mb-4">
                                                            <h4 className="font-bold text-gray-900 text-lg">{unit.name}</h4>
                                                            {unit.bookingMade && (
                                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                                                                    </svg>
                                                                    Booking Made
                                                                </span>
                                                            )}
                                                        </div>
                                                        {/* Voucher Type */}
                                                        <div className="mb-4">
                                                            <span className="text-gray-500 block text-sm">Voucher Type</span>
                                                            <span className="font-medium text-gray-900">{accommodationLabels[unit.accommodationType] || unit.accommodationType || 'N/A'}</span>
                                                        </div>

                                                        {/* Accommodation Details — render the fields this unit actually
                                                            carries. Hotel bookings store arrival/departure dates and
                                                            nights; voucher requests store a validity period, people and
                                                            room type. Rendering the wrong shape used to show N/A for
                                                            everything the user had filled in. */}
                                                        {!['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only'].includes(unit.accommodationType) && (
                                                            (unit.arrivalDate || unit.departureDate) ? (
                                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                                                    <div>
                                                                        <span className="text-gray-500 block">Arrival Date</span>
                                                                        <span className="font-medium text-gray-900">{unit.arrivalDate || 'N/A'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500 block">Departure Date</span>
                                                                        <span className="font-medium text-gray-900">{unit.departureDate || 'N/A'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500 block">No. of Nights</span>
                                                                        <span className="font-medium text-gray-900">{unit.numberOfNights || 'N/A'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500 block">No. of Rooms</span>
                                                                        <span className="font-medium text-gray-900">{unit.numberOfRooms || 'N/A'}</span>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                                                    <div>
                                                                        <span className="text-gray-500 block">Validity Period</span>
                                                                        <span className="font-medium text-gray-900">{unit.voucherValidityPeriod || 'N/A'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500 block">No. of People</span>
                                                                        <span className="font-medium text-gray-900">{unit.numberOfPeople || 'N/A'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500 block">No. of Rooms</span>
                                                                        <span className="font-medium text-gray-900">{unit.numberOfRooms || 'N/A'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500 block">Room Type</span>
                                                                        <span className="font-medium text-gray-900">{unit.roomType || 'N/A'}</span>
                                                                    </div>
                                                                </div>
                                                            )
                                                        )}

                                                        {/* Meal Details — only when this unit carries meal fields */}
                                                        {(['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only'].includes(unit.accommodationType)
                                                            || unit.numberOfMeals || unit.mealPeopleCount) && (
                                                            <div className={`grid grid-cols-2 gap-4 text-sm ${!['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only'].includes(unit.accommodationType) ? 'mt-4 pt-4 border-t border-gray-100' : ''}`}>
                                                                <div>
                                                                    <span className="text-gray-500 block">Number of Meals</span>
                                                                    <span className="font-medium text-gray-900">{unit.numberOfMeals || 'N/A'}</span>
                                                                </div>
                                                                <div>
                                                                    <span className="text-gray-500 block">Number of People for Meals</span>
                                                                    <span className="font-medium text-gray-900">{unit.mealPeopleCount || 'N/A'}</span>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {/* Special Arrangements */}
                                                        <div className="mt-4 pt-4 border-t border-gray-100 text-sm">
                                                            <div>
                                                                <span className="text-gray-500 block">Special Arrangements</span>
                                                                <span className="font-medium text-gray-900">{unit.specialArrangements || 'N/A'}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </Card>
                                    )}

                                    {/* Travel Document Section */}
                                    {hasTravelDocument && (
                                        <Card className="!p-0 overflow-hidden border-[#C9B896] shadow-sm">
                                            <div className="bg-[#F3EADC]/50 px-6 py-4 border-b border-[#E6D3B3]">
                                                <h3 className="font-semibold text-[#3F2D19] flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                    </svg>
                                                    Local Travel Authorization
                                                </h3>
                                            </div>
                                            <div className="p-6 space-y-6">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                    <div>
                                                        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1 block">Date of Intended Travel</label>
                                                        <div className="text-text-primary font-medium text-base border-b border-gray-100 pb-2">
                                                            {travelDocument.dateOfIntendedTravel ? new Date(travelDocument.dateOfIntendedTravel).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'N/A'}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1 block">Travel Mode</label>
                                                        <div className="text-text-primary font-medium text-base border-b border-gray-100 pb-2">{travelDocument.travelMode || 'N/A'}</div>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1 block">Purpose of Travel</label>
                                                    <div className="text-text-primary font-medium text-base border-b border-gray-100 pb-2 whitespace-pre-wrap">{travelDocument.purposeOfTravel || 'N/A'}</div>
                                                </div>
                                                {travelDocument.accompanyingAssociates && (
                                                    <div>
                                                        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1 block">Accompanying Associates</label>
                                                        <div className="text-text-primary font-medium text-base border-b border-gray-100 pb-2 whitespace-pre-wrap">{travelDocument.accompanyingAssociates}</div>
                                                    </div>
                                                )}

                                                {/* Travel Itinerary */}
                                                {travelDocument.itinerary && travelDocument.itinerary.length > 0 && (
                                                    <div>
                                                        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3 block">Travel Itinerary</label>
                                                        <div className="overflow-x-auto">
                                                            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                                                                <thead className="bg-gray-50">
                                                                    <tr>
                                                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Date</th>
                                                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">From</th>
                                                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">To</th>
                                                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">KM</th>
                                                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Justification</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody>
                                                                    {travelDocument.itinerary.map((row: any, idx: number) => (
                                                                        <tr key={idx} className="border-t border-gray-100">
                                                                            <td className="px-3 py-2 text-gray-900">{row.date ? new Date(row.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-'}</td>
                                                                            <td className="px-3 py-2 text-gray-900">{row.from || '-'}</td>
                                                                            <td className="px-3 py-2 text-gray-900">{row.to || '-'}</td>
                                                                            <td className="px-3 py-2 text-gray-900">{row.km || '-'}</td>
                                                                            <td className="px-3 py-2 text-gray-900">{row.justification || '-'}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Travel Budget */}
                                                {travelDocument.budget && (
                                                    <div>
                                                        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3 block">Travel Budget</label>
                                                        <div className="overflow-x-auto">
                                                            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                                                                <thead className="bg-gray-50">
                                                                    <tr>
                                                                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Item</th>
                                                                        <th className="px-3 py-2 text-right font-semibold text-gray-700">Qty</th>
                                                                        <th className="px-3 py-2 text-right font-semibold text-gray-700">Unit Cost</th>
                                                                        <th className="px-3 py-2 text-right font-semibold text-gray-700">Total</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody>
                                                                    {travelDocument.budget.aaRates?.totalCost && parseFloat(travelDocument.budget.aaRates.totalCost) > 0 && (
                                                                        <tr className="border-t border-gray-100 bg-[#F3EADC]">
                                                                            <td className="px-3 py-2 text-gray-900 font-medium">Travel Cost (AA Rate × Distance)</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">{travelDocument.budget.aaRates.quantity} km</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">${travelDocument.budget.aaRates.unitCost}/km</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right font-medium">${travelDocument.budget.aaRates.totalCost}</td>
                                                                        </tr>
                                                                    )}
                                                                    {travelDocument.budget.airBusTickets?.totalCost && parseFloat(travelDocument.budget.airBusTickets.totalCost) > 0 && (
                                                                        <tr className="border-t border-gray-100">
                                                                            <td className="px-3 py-2 text-gray-900">Air/Bus Tickets</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">{travelDocument.budget.airBusTickets.quantity}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">${travelDocument.budget.airBusTickets.unitCost}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right font-medium">${travelDocument.budget.airBusTickets.totalCost}</td>
                                                                        </tr>
                                                                    )}
                                                                    {travelDocument.budget.conferencingCost?.totalCost && parseFloat(travelDocument.budget.conferencingCost.totalCost) > 0 && (
                                                                        <tr className="border-t border-gray-100">
                                                                            <td className="px-3 py-2 text-gray-900">Conferencing Cost</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">{travelDocument.budget.conferencingCost.quantity}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">${travelDocument.budget.conferencingCost.unitCost}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right font-medium">${travelDocument.budget.conferencingCost.totalCost}</td>
                                                                        </tr>
                                                                    )}
                                                                    {/* Tollgates - support both old format (single object) and new format (array) */}
                                                                    {Array.isArray(travelDocument.budget.tollgates) ? (
                                                                        travelDocument.budget.tollgates.filter((t: any) => t.totalCost && parseFloat(t.totalCost) > 0).map((toll: any, idx: number) => (
                                                                            <tr key={idx} className="border-t border-gray-100 bg-orange-50/30">
                                                                                <td className="px-3 py-2 text-gray-900">Tollgate{toll.road ? `: ${toll.road}` : ''}</td>
                                                                                <td className="px-3 py-2 text-gray-900 text-right">{toll.quantity}</td>
                                                                                <td className="px-3 py-2 text-gray-900 text-right">${toll.unitCost}</td>
                                                                                <td className="px-3 py-2 text-gray-900 text-right font-medium">${toll.totalCost}</td>
                                                                            </tr>
                                                                        ))
                                                                    ) : (
                                                                        travelDocument.budget.tollgates?.totalCost && parseFloat(travelDocument.budget.tollgates.totalCost) > 0 && (
                                                                            <tr className="border-t border-gray-100">
                                                                                <td className="px-3 py-2 text-gray-900">Tollgates</td>
                                                                                <td className="px-3 py-2 text-gray-900 text-right">{travelDocument.budget.tollgates.quantity}</td>
                                                                                <td className="px-3 py-2 text-gray-900 text-right">${travelDocument.budget.tollgates.unitCost}</td>
                                                                                <td className="px-3 py-2 text-gray-900 text-right font-medium">${travelDocument.budget.tollgates.totalCost}</td>
                                                                            </tr>
                                                                        )
                                                                    )}
                                                                    {travelDocument.budget.other?.totalCost && parseFloat(travelDocument.budget.other.totalCost) > 0 && (
                                                                        <tr className="border-t border-gray-100">
                                                                            <td className="px-3 py-2 text-gray-900">Other{travelDocument.budget.other.description ? ` (${travelDocument.budget.other.description})` : ''}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">{travelDocument.budget.other.quantity}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right">${travelDocument.budget.other.unitCost}</td>
                                                                            <td className="px-3 py-2 text-gray-900 text-right font-medium">${travelDocument.budget.other.totalCost}</td>
                                                                        </tr>
                                                                    )}
                                                                </tbody>
                                                                <tfoot className="bg-primary-50">
                                                                    <tr className="border-t-2 border-primary-200">
                                                                        <td colSpan={3} className="px-3 py-3 text-right font-bold text-primary-800">Grand Total</td>
                                                                        <td className="px-3 py-3 text-right font-bold text-primary-800">
                                                                            ${(() => {
                                                                                const b = travelDocument.budget;
                                                                                const tollgatesTotal = Array.isArray(b.tollgates) 
                                                                                    ? b.tollgates.reduce((sum: number, t: any) => sum + (parseFloat(t.totalCost) || 0), 0)
                                                                                    : parseFloat(b.tollgates?.totalCost) || 0;
                                                                                const vals = [b.aaRates?.totalCost, b.airBusTickets?.totalCost, b.conferencingCost?.totalCost, b.other?.totalCost];
                                                                                return vals.reduce((sum: number, v: any) => sum + (parseFloat(v) || 0), tollgatesTotal).toFixed(2);
                                                                            })()}
                                                                        </td>
                                                                    </tr>
                                                                </tfoot>
                                                            </table>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </Card>
                                    )}

                                    {/* Supporting Documents Section */}
                                    {supportingDocuments.length > 0 && (
                                        <Card className="!p-0 overflow-hidden border-[#E6D3B3] shadow-sm">
                                            <div className="bg-[#F3EADC]/50 px-6 py-4 border-b border-[#E6D3B3] flex items-center justify-between">
                                                <h3 className="font-semibold text-[#3F2D19] flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                    </svg>
                                                    Supporting Documents
                                                </h3>
                                                <span className="text-sm text-[#9A7545] font-medium">{supportingDocuments.length} file(s)</span>
                                            </div>
                                            <div className="p-4 space-y-3">
                                                {supportingDocuments.map((doc: any, index: number) => (
                                                    <div key={index} className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 transition-colors">
                                                        <div className="w-12 h-12 bg-[#F3EADC] rounded-lg flex items-center justify-center flex-shrink-0">
                                                            <svg className="w-6 h-6 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                            </svg>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="font-medium text-gray-900 truncate">{doc.name || doc.filename || 'Document'}</p>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                {doc.label && (
                                                                    <span className="text-xs bg-[#F3EADC] text-[#5E4426] px-2 py-0.5 rounded-full font-medium">{doc.label}</span>
                                                                )}
                                                                {doc.size && (
                                                                    <span className="text-xs text-gray-500">{(doc.size / 1024 / 1024).toFixed(2)} MB</span>
                                                                )}
                                                            </div>
                                                            {doc.description && (
                                                                <p className="text-sm text-gray-600 mt-1">{doc.description}</p>
                                                            )}
                                                            {doc.uploadedBy && (
                                                                <p className="text-xs text-gray-400 mt-1">
                                                                    Uploaded by {doc.uploadedBy.name} {doc.uploadedAt ? `on ${new Date(doc.uploadedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : ''}
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </Card>
                                    )}

                                    {/* Administration Section - Only shows when request is fully approved */}
                                    {actualStatus === 'approved' && (
                                        <Card className="!p-0 overflow-hidden border-emerald-200 shadow-sm">
                                            <div className="bg-emerald-50 px-6 py-4 border-b border-emerald-100">
                                                <h3 className="font-semibold text-emerald-800 flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                    </svg>
                                                    Administration
                                                    <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">Post-Approval</span>
                                                </h3>
                                            </div>
                                            <div className="p-6 space-y-4">
                                                <p className="text-sm text-gray-600 mb-4">This section is for administrative use after the request has been fully approved.</p>
                                                
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                    <div>
                                                        <label className="block text-sm font-medium text-gray-700 mb-1">Funds Issued By</label>
                                                        <div className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-700">
                                                            {metadata.administration?.fundsIssuedBy || <span className="text-gray-400 italic">Not yet recorded</span>}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <label className="block text-sm font-medium text-gray-700 mb-1">Funds Collected By</label>
                                                        <div className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-700">
                                                            {metadata.administration?.fundsCollectedBy || <span className="text-gray-400 italic">Not yet recorded</span>}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div>
                                                    <label className="block text-sm font-medium text-gray-700 mb-1">Additional Comments</label>
                                                    <div className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-700 min-h-[60px]">
                                                        {metadata.administration?.additionalComments || <span className="text-gray-400 italic">No additional comments</span>}
                                                    </div>
                                                </div>

                                                {/* Scanned Document Upload Section */}
                                                <div className="mt-6 pt-4 border-t border-gray-200">
                                                    <h4 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
                                                        <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                                        </svg>
                                                        Attached Travel Document
                                                    </h4>
                                                    <p className="text-xs text-gray-500 mb-3">Upload a scanned copy of the signed travel document or any supporting forms.</p>
                                                    
                                                    {metadata.administration?.scannedDocument ? (
                                                        <div className="flex items-center gap-3 p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                                                            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                            </svg>
                                                            <div className="flex-1">
                                                                <p className="font-medium text-emerald-800">{metadata.administration.scannedDocument.filename}</p>
                                                                <p className="text-xs text-emerald-600">Uploaded on {new Date(metadata.administration.scannedDocument.uploadedAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</p>
                                                            </div>
                                                            <a href={metadata.administration.scannedDocument.url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 transition-colors">
                                                                View
                                                            </a>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center justify-center p-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                                                            <div className="text-center">
                                                                <svg className="w-10 h-10 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                                                </svg>
                                                                <p className="text-sm text-gray-500">No document uploaded yet</p>
                                                                <p className="text-xs text-gray-400 mt-1">Document upload will be available soon</p>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </Card>
                                    )}
                                </div>
                            )}

                            {activeTab === 'timeline' && (
                                <div className="space-y-6">
                                    <Card className="!p-6 border-gray-100 shadow-sm">
                                        <h3 className="text-lg font-bold text-text-primary mb-6 font-heading">Approval Timeline</h3>
                                        <ApprovalTimeline 
                                            request={request} 
                                            onRedirect={handleOpenRedirectModal}
                                            canRedirect={canRedirectApprovals}
                                        />
                                    </Card>
                                </div>
                            )}

                            {activeTab === 'documents' && (
                                <div className="space-y-6">
                                    {/* Request Summary Card for Approvers */}
                                    <Card className="!p-0 overflow-hidden border-primary-100 shadow-sm bg-gradient-to-br from-primary-50/50 via-white to-white">
                                        <div className="bg-primary-50/80 px-6 py-4 border-b border-primary-100">
                                            <h3 className="font-semibold text-primary-800 flex items-center gap-2">
                                                <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                                Request Summary
                                            </h3>
                                        </div>
                                        <div className="p-6 space-y-4">
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div className="space-y-1">
                                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Request Title</span>
                                                    <p className="text-gray-900 font-medium">{request.title}</p>
                                                </div>
                                                <div className="space-y-1">
                                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Request ID</span>
                                                    <p className="text-gray-900 font-mono text-sm">#{request.id.substring(0, 8).toUpperCase()}</p>
                                                </div>
                                                {/* A comp requester is usually the guest — only surface
                                                    "Submitted By" when it was filed on behalf of someone else. */}
                                                {(metadata.onBehalfOf?.userId || metadata.onBehalfOf?.name) && (
                                                    <div className="space-y-1">
                                                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Submitted By</span>
                                                        <div className="flex items-center gap-2">
                                                            <img
                                                                src={request.creator.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(request.creator.display_name || 'User')}&background=random&size=24`}
                                                                alt={request.creator.display_name}
                                                                className="w-6 h-6 rounded-full"
                                                            />
                                                            <div>
                                                                <p className="text-gray-900 font-medium">{request.creator.display_name}</p>
                                                                <p className="text-xs text-gray-500">{request.creator.job_title || 'Employee'}</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="space-y-1">
                                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Submitted On</span>
                                                    <p className="text-gray-900">{new Date(request.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</p>
                                                </div>
                                            </div>
                                            {request.description && (
                                                <div className="pt-3 border-t border-gray-100">
                                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Description</span>
                                                    <p className="text-gray-700 mt-1">{request.description}</p>
                                                </div>
                                            )}
                                        </div>
                                    </Card>

                                    {loadingDocuments ? (
                                        <div className="flex items-center justify-center py-12">
                                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
                                        </div>
                                    ) : documents.length > 0 ? (
                                        <Card className="!p-0 overflow-hidden border-gray-200 shadow-sm">
                                            <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                                                <h3 className="font-semibold text-text-primary font-heading flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                                    </svg>
                                                    Uploaded Documents
                                                </h3>
                                                <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded-full">{documents.length} file{documents.length !== 1 ? 's' : ''}</span>
                                            </div>
                                            <div className="p-4 space-y-4">
                                                {documents.map((doc: any, index: number) => {
                                                    const fileExt = doc.filename?.split('.').pop()?.toLowerCase() || '';
                                                    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(fileExt);
                                                    const isPdf = fileExt === 'pdf';
                                                    const isWord = ['doc', 'docx'].includes(fileExt);
                                                    const isExcel = ['xls', 'xlsx', 'csv'].includes(fileExt);
                                                    
                                                    const getFileIcon = () => {
                                                        if (isImage) return (
                                                            <svg className="w-6 h-6 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                            </svg>
                                                        );
                                                        if (isPdf) return (
                                                            <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                                            </svg>
                                                        );
                                                        if (isWord) return (
                                                            <svg className="w-6 h-6 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                            </svg>
                                                        );
                                                        if (isExcel) return (
                                                            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                                                            </svg>
                                                        );
                                                        return (
                                                            <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                            </svg>
                                                        );
                                                    };
                                                    
                                                    const getFileBgColor = () => {
                                                        if (isImage) return 'bg-[#F3EADC]';
                                                        if (isPdf) return 'bg-red-50';
                                                        if (isWord) return 'bg-[#F3EADC]';
                                                        if (isExcel) return 'bg-green-50';
                                                        return 'bg-primary-50';
                                                    };

                                                    const formatFileSize = (bytes: number) => {
                                                        if (!bytes) return 'Unknown size';
                                                        if (bytes < 1024) return `${bytes} B`;
                                                        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                                                        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
                                                    };

                                                    return (
                                                        <div key={doc.id} className="p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all">
                                                            <div className="flex items-start gap-4">
                                                                <div className={`w-14 h-14 ${getFileBgColor()} rounded-xl flex items-center justify-center flex-shrink-0`}>
                                                                    {getFileIcon()}
                                                                </div>
                                                                <div className="flex-1 min-w-0">
                                                                    <div className="flex items-start justify-between gap-4">
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                                <p className="font-semibold text-gray-900 truncate text-lg">{doc.filename}</p>
                                                                                {doc.label && (
                                                                                    <span className="text-xs bg-[#F3EADC] text-[#5E4426] px-2 py-0.5 rounded-full font-medium">{doc.label}</span>
                                                                                )}
                                                                            </div>
                                                                            {doc.description && (
                                                                                <p className="text-sm text-gray-600 mt-1">{doc.description}</p>
                                                                            )}
                                                                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-gray-500">
                                                                                <span className="inline-flex items-center gap-1">
                                                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                                                                                    </svg>
                                                                                    {formatFileSize(doc.file_size)}
                                                                                </span>
                                                                                <span className="inline-flex items-center gap-1">
                                                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                                                                    </svg>
                                                                                    {fileExt.toUpperCase() || 'FILE'}
                                                                                </span>
                                                                                {doc.mime_type && (
                                                                                    <span className="inline-flex items-center gap-1 text-xs bg-gray-100 px-2 py-0.5 rounded">
                                                                                        {doc.mime_type}
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                            <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
                                                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                                                </svg>
                                                                                Uploaded {new Date(doc.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                                                            </div>
                                                                        </div>
                                                                        <div className="flex flex-col gap-2 flex-shrink-0">
                                                                            {doc.download_url && (
                                                                                <>
                                                                                    <Button variant="primary" size="sm" className="gap-1.5" onClick={() => window.open(doc.download_url, '_blank')}>
                                                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                                                                        </svg>
                                                                                        Download
                                                                                    </Button>
                                                                                    {(isImage || isPdf) && (
                                                                                        <Button variant="outline" size="sm" className="gap-1.5 bg-white" onClick={() => window.open(doc.download_url, '_blank')}>
                                                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                                                            </svg>
                                                                                            Preview
                                                                                        </Button>
                                                                                    )}
                                                                                </>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </Card>
                                    ) : (
                                        <Card className="text-center py-12 border-dashed border-2 border-gray-200 bg-gray-50/50 shadow-none">
                                            <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                                                <svg className="w-8 h-8 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                                </svg>
                                            </div>
                                            <h3 className="text-lg font-medium text-text-primary">No Documents Yet</h3>
                                            <p className="text-text-secondary">No documents have been uploaded for this request.</p>
                                        </Card>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Right Column: Sidebar */}
                    <div className="space-y-6">
                        <Card className="!p-6 border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                            <h3 className="text-sm font-bold text-text-secondary uppercase tracking-widest mb-4">Requester</h3>
                            <div className="flex items-center gap-4">
                                <img
                                    src={request.creator.profile_picture_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(request.creator.display_name || 'User')}&background=random`}
                                    alt={request.creator.display_name || 'User'}
                                    className="w-14 h-14 rounded-full border-2 border-white shadow-sm object-cover"
                                />
                                <div>
                                    <div className="font-bold text-text-primary text-lg">{request.creator.display_name}</div>
                                    <div className="text-sm text-text-secondary">{request.creator.job_title || 'No Job Title'}</div>
                                    <div className="text-xs text-primary-600 mt-1">{request.creator.email}</div>
                                </div>
                            </div>
                        </Card>

                        <Card className="!p-6 border-primary-100 bg-gradient-to-br from-white to-primary-50/50 shadow-sm relative overflow-hidden">
                            <h3 className="text-sm font-bold text-primary-500 uppercase tracking-widest mb-2">Current Step</h3>
                            <div className="text-2xl font-bold text-text-primary mb-1">
                                {request.request_steps?.find((s) => s.step_index + 1 === request.current_step)?.approver_role || (request.current_step > request.total_steps ? 'Completed' : 'Pending')}
                            </div>
                            {request.current_approver ? (
                                <div className="flex items-center gap-2 mt-4 p-3 bg-white/60 rounded-lg backdrop-blur-sm border border-white/50">
                                    <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs">
                                        {request.current_approver.display_name?.charAt(0) || '?'}
                                    </div>
                                    <div>
                                        <div className="text-xs text-text-secondary">Waiting for</div>
                                        <div className="text-sm font-semibold text-text-primary">{request.current_approver.display_name}</div>
                                    </div>
                                </div>
                            ) : (
                                <div className="mt-4 text-sm text-text-secondary">No active approver pending.</div>
                            )}
                        </Card>

                        <Card className="!p-0 border-gray-200 overflow-hidden text-sm">
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                                <span className="text-text-secondary">Status</span>
                                <span className="font-medium text-text-primary">{statusInfo.label}</span>
                            </div>
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center">
                                <span className="text-text-secondary">Created</span>
                                <span className="font-medium text-text-primary">{new Date(request.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                            </div>
                            <div className="p-4 flex justify-between items-center">
                                <span className="text-text-secondary">Last Updated</span>
                                <span className="font-medium text-text-primary">{new Date(request.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                            </div>
                        </Card>

                        {/* Watchers Section */}
                        {metadata.watchers && Array.isArray(metadata.watchers) && metadata.watchers.length > 0 && (
                            <Card className="!p-6 border-[#E6D3B3] bg-gradient-to-br from-white to-[#FAF6F1]/30 shadow-sm">
                                <div className="flex items-center gap-2 mb-4">
                                    <svg className="w-4 h-4 text-[#9A7545]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                    </svg>
                                    <h3 className="text-sm font-bold text-[#5E4426] uppercase tracking-widest">Watchers</h3>
                                    <span className="ml-auto text-xs bg-[#F3EADC] text-[#9A7545] px-2 py-0.5 rounded-full font-medium">
                                        {metadata.watchers.length}
                                    </span>
                                </div>
                                <p className="text-xs text-gray-500 mb-3">
                                    These users can view this request and generate the voucher once approved.
                                </p>
                                <div className="space-y-2">
                                    {metadata.watchers.map((watcher: any) => (
                                        <div key={watcher.id} className="flex items-center gap-3 p-2 bg-white/60 rounded-lg border border-[#E6D3B3]/50">
                                            <div className="w-8 h-8 rounded-full bg-[#F3EADC] flex items-center justify-center flex-shrink-0">
                                                <span className="text-sm font-medium text-[#9A7545]">
                                                    {watcher.display_name?.charAt(0)?.toUpperCase() || '?'}
                                                </span>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-gray-900 truncate">{watcher.display_name}</p>
                                                <p className="text-xs text-gray-500 truncate">{watcher.email}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </Card>
                        )}
                    </div>
                </div>

                {/* Publish Confirmation Modal */}
                {showPublishConfirm && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-12 h-12 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                    <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                    </svg>
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-text-primary">Publish Request</h3>
                                    <p className="text-sm text-text-secondary">Submit for approval</p>
                                </div>
                            </div>
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
                                <div className="flex items-start gap-3">
                                    <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                    </svg>
                                    <div>
                                        <p className="text-sm font-medium text-amber-800">Important Notice</p>
                                        <p className="text-sm text-amber-700 mt-1">
                                            Once an approver has approved this request, you will no longer be able to delete it. Please ensure all information is correct before publishing.
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <p className="text-text-secondary mb-6">
                                Are you sure you want to publish &ldquo;<span className="font-medium text-text-primary">{request?.title}</span>&rdquo; and send it for approval?
                            </p>
                            <div className="flex gap-3 justify-end">
                                <Button variant="outline" onClick={() => setShowPublishConfirm(false)} disabled={publishing}>Cancel</Button>
                                <Button variant="primary" onClick={() => { setShowPublishConfirm(false); handlePublish(); }} disabled={publishing} isLoading={publishing}>
                                    {publishing ? 'Publishing...' : 'Publish Request'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Delete Confirmation Modal */}
                {showDeleteConfirm && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-12 h-12 rounded-full bg-danger-100 flex items-center justify-center flex-shrink-0">
                                    <svg className="w-6 h-6 text-danger-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-text-primary">Delete Request</h3>
                                    <p className="text-sm text-text-secondary">This action cannot be undone</p>
                                </div>
                            </div>
                            <p className="text-text-secondary mb-6">
                                Are you sure you want to delete &ldquo;<span className="font-medium text-text-primary">{request.title}</span>&rdquo;?
                            </p>
                            <div className="flex gap-3 justify-end">
                                <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>Cancel</Button>
                                <Button variant="danger" onClick={handleDelete} disabled={deleting} isLoading={deleting}>
                                    {deleting ? 'Deleting...' : 'Delete Request'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Review/Approval Modal */}
                {showReviewModal && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
                            <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4 rounded-t-2xl flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Review Request</h2>
                                    <p className="text-xs text-gray-500 mt-0.5">#{request.id.slice(0, 8)}</p>
                                </div>
                                <button onClick={() => { setShowReviewModal(false); setReviewComment(''); setReviewError(null); }} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>

                            <div className="p-6 space-y-6">
                                <div className="space-y-1">
                                    <h3 className="text-xl font-semibold text-gray-900">{request.title}</h3>
                                    <p className="text-gray-600 leading-relaxed text-sm">{request.description || 'No description provided.'}</p>
                                </div>

                                {needsAuthFirst ? (
                                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                                        <div className="flex items-start gap-3">
                                            <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                            </svg>
                                            <div>
                                                <h4 className="text-sm font-semibold text-amber-900">Identity verification required</h4>
                                                <p className="text-xs text-amber-800 mt-1">
                                                    {approvalRisk === 'high'
                                                        ? 'This is a high-risk approval. Verify with biometrics or Microsoft MFA before signing.'
                                                        : 'Verify with Microsoft MFA before signing this approval.'}
                                                </p>
                                                <p className="text-xs text-amber-700 mt-2">Your signature options will appear after verification.</p>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bg-primary-50 border border-primary-100 rounded-xl p-4">
                                        <div className="text-xs text-primary-600 uppercase tracking-wide font-medium mb-2">Your Signature</div>
                                        <SignatureSelector
                                            savedSignatureUrl={userSignatureUrl}
                                            userDisplayName={(session?.user as any)?.name || request?.creator?.display_name}
                                            value={signatureSelection}
                                            onChange={setSignatureSelection}
                                            disabled={reviewProcessing}
                                        />
                                        <p className="text-xs text-primary-600 mt-2">
                                            Your signature will be attached to this approval.
                                        </p>
                                    </div>
                                )}

                                {reviewError && (
                                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                                        <svg className="w-4 h-4 text-red-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        <p className="text-sm text-red-600 font-medium">{reviewError}</p>
                                    </div>
                                )}

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">Review Comment <span className="text-gray-400 font-normal">(Required for rejection)</span></label>
                                    <textarea
                                        value={reviewComment}
                                        onChange={(e) => setReviewComment(e.target.value)}
                                        placeholder="Enter your feedback or reasoning here..."
                                        className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-shadow"
                                        rows={4}
                                    />
                                </div>
                            </div>

                            <div className="p-6 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3 rounded-b-2xl">
                                <Button variant="outline" onClick={() => { setShowReviewModal(false); setReviewComment(''); setReviewError(null); }} disabled={reviewProcessing} className="bg-white hover:bg-gray-50">Cancel</Button>
                                <Button
                                    variant="danger"
                                    onClick={() => {
                                        if (!reviewComment.trim()) {
                                            setReviewError('Please provide a reason for rejection');
                                            return;
                                        }
                                        setReviewError(null);
                                        setShowRejectConfirm(true);
                                    }}
                                    disabled={reviewProcessing}
                                    className="min-w-[5rem]"
                                >
                                    {reviewProcessing ? '...' : 'Reject'}
                                </Button>
                                <Button variant="primary" onClick={() => handleApprovalAction('approve')} disabled={reviewProcessing} className="min-w-[6rem]">{reviewProcessing ? 'Processing...' : needsAuthFirst ? (approvalRisk === 'high' ? 'Verify Identity' : 'Verify with Microsoft') : 'Approve'}</Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </AppLayout>
    );
}
