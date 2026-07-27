import { Fragment, ReactNode, forwardRef, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSuppressToastsWhileOpen } from './ToastProvider';
import { formatDateTime } from '../../lib/formatDate';

export interface PreviewField {
    label: string;
    value: ReactNode;
    fullWidth?: boolean;
}

export interface PreviewSection {
    title?: string;
    fields?: PreviewField[];
    /** When provided, rendered in place of `fields` — use for tables, multi-column layouts, etc. */
    content?: ReactNode;
    /** Start this section on a new printed page (and show a divider on screen).
     *  Used e.g. to render a combined comp + travel document as two pages. */
    pageBreakBefore?: boolean;
}

export interface DocumentHeader {
    /** Path or URL to the logo image (e.g. /images/RTG_LOGO.png). Absolute URL used in the print window. */
    logoUrl?: string;
    /** Left-aligned document identifier (e.g. "DOC NO: HR APX – 27 LOCAL TRAVEL AUTHORISATION"). */
    docNo?: string;
    /** Center-aligned department label (e.g. "DEPARTMENT: HUMAN RESOURCES"). */
    department?: string;
    /** Right-aligned page indicator (e.g. "PAGE: 1 of 1"). */
    page?: string;
}

interface RequestPreviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    mode: 'preview' | 'confirm';
    title: string;
    subtitle?: string;
    sections: PreviewSection[];
    onConfirm?: () => void;
    confirming?: boolean;
    confirmLabel?: string;
    documentHeader?: DocumentHeader;
}

const DEFAULT_LOGO = '/images/RTG_LOGO.png';

// ──────────────────────────────────────────────────────────────────────
// RequestPreviewDocument
// ──────────────────────────────────────────────────────────────────────
// The inner document body, factored out so it can also be embedded
// inline (e.g. as the default tab on /requests/[id]). The modal wraps
// this exact node with its chrome and print button. Keep this component
// dumb — it only renders the document layout.
// ──────────────────────────────────────────────────────────────────────
interface RequestPreviewDocumentProps {
    title: string;
    subtitle?: string;
    sections: PreviewSection[];
    documentHeader?: DocumentHeader;
}

export const RequestPreviewDocument = forwardRef<HTMLDivElement, RequestPreviewDocumentProps>(
    function RequestPreviewDocument({ title, subtitle, sections, documentHeader }, ref) {
        const header: DocumentHeader = {
            logoUrl: documentHeader?.logoUrl ?? DEFAULT_LOGO,
            docNo: documentHeader?.docNo,
            department: documentHeader?.department,
            page: documentHeader?.page ?? 'PAGE: 1 of 1',
        };

        return (
            <div ref={ref} className="bg-white rounded-xl border border-gray-200 shadow-sm p-8">
                {header.logoUrl && (
                    <div className="doc-logo-wrap" style={{ textAlign: 'center', marginBottom: 10 }}>
                        <img
                            src={header.logoUrl}
                            alt="RTG Logo"
                            style={{ maxHeight: 70, width: 'auto', display: 'inline-block' }}
                        />
                    </div>
                )}

                {(header.docNo || header.department || header.page) && (
                    <table
                        className="doc-id-strip"
                        style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            border: '1px solid #111',
                            margin: '8px 0 16px',
                            fontSize: 11,
                        }}
                    >
                        <tbody>
                            <tr>
                                <td style={{ border: '1px solid #111', padding: '6px 10px', fontWeight: 600, textAlign: 'left', width: '40%' }}>
                                    {header.docNo || ''}
                                </td>
                                <td style={{ border: '1px solid #111', padding: '6px 10px', fontWeight: 600, textAlign: 'center', width: '40%' }}>
                                    {header.department || ''}
                                </td>
                                <td style={{ border: '1px solid #111', padding: '6px 10px', fontWeight: 600, textAlign: 'right', width: '20%' }}>
                                    {header.page || ''}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                )}

                <h1
                    className="text-base font-bold text-gray-900 mb-1 uppercase tracking-wide text-center"
                    style={{ textAlign: 'center' }}
                >
                    {title}
                </h1>
                {subtitle && (
                    <p className="subtitle text-xs text-gray-500 mb-3 text-center" style={{ textAlign: 'center' }}>
                        {subtitle}
                    </p>
                )}

                {sections.map((section, i) => (
                    <div
                        key={i}
                        className={section.pageBreakBefore ? 'preview-page-break' : undefined}
                        style={section.pageBreakBefore ? { breakBefore: 'page', pageBreakBefore: 'always' } : undefined}
                    >
                        {section.pageBreakBefore && i > 0 && (
                            <div
                                className="preview-page-divider"
                                style={{
                                    borderTop: '2px dashed #cbd5e1',
                                    margin: '32px 0 20px',
                                    paddingTop: 8,
                                    textAlign: 'center',
                                    fontSize: 10,
                                    letterSpacing: '0.12em',
                                    textTransform: 'uppercase',
                                    color: '#94a3b8',
                                }}
                            >
                                Page 2
                            </div>
                        )}
                        {section.title && (
                            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-900 border-b border-gray-300 pb-1.5 mt-5 mb-2">
                                {section.title}
                            </h2>
                        )}
                        {section.content ? (
                            <div className="text-sm text-gray-900">{section.content}</div>
                        ) : section.fields ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                                {section.fields.map((f, j) => (
                                    <div key={j} className={`field ${f.fullWidth ? 'sm:col-span-2 full' : ''}`}>
                                        <div className="label text-xs font-semibold text-gray-600 mb-0.5 uppercase">
                                            {f.label}
                                        </div>
                                        <div className="value text-sm text-gray-900 whitespace-pre-wrap">
                                            {f.value === '' || f.value === null || f.value === undefined
                                                ? <span className="text-gray-400 italic">—</span>
                                                : f.value}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ))}

                {/* System-generation stamp — a truthful record of when this
                    document was produced from The Circle. Uses the `footer`
                    class so the shared print stylesheet targets it too; the
                    print helper therefore does NOT append its own footer. */}
                <div
                    className="footer"
                    style={{
                        marginTop: 24,
                        fontSize: 9,
                        color: '#999',
                        borderTop: '1px solid #eee',
                        paddingTop: 6,
                        textAlign: 'center',
                    }}
                >
                    Generated from The Circle on {formatDateTime(new Date())}
                </div>
            </div>
        );
    }
);

// Shared print helper — opens a new window with the document HTML and
// triggers the browser's print dialog. Exposed so the inline preview
// can offer the same Print button as the modal.
export function printPreviewDocument(node: HTMLElement | null, title: string) {
    if (!node) return;
    const clone = node.cloneNode(true) as HTMLDivElement;
    clone.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src');
        if (src && src.startsWith('/')) {
            img.setAttribute('src', window.location.origin + src);
        }
    });
    const html = clone.innerHTML;
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>${title}</title>
        <meta charset="utf-8" />
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; padding: 24px; }
            h1 { font-size: 18px; margin: 0 0 4px; color: #111827; text-align: center; text-transform: uppercase; letter-spacing: 0.04em; }
            h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #111827; border-bottom: 1px solid #9ca3af; padding-bottom: 4px; margin: 18px 0 10px; }
            .doc-logo-wrap { text-align: center; margin-bottom: 10px; }
            .doc-logo-wrap img { max-height: 70px; width: auto; display: inline-block; }
            table { border-collapse: collapse; width: 100%; font-size: 11px; }
            table.doc-id-strip { border: 1px solid #111; margin: 8px 0 16px; }
            table.doc-id-strip td { border: 1px solid #111; padding: 6px 10px; font-weight: 600; font-size: 11px; }
            table td, table th { border: 1px solid #333; padding: 6px 8px; vertical-align: top; }
            table th { background: #F3F4F6; color: #111827; text-align: left; font-weight: 700; }
            .subtitle { color: #666; font-size: 11px; margin-bottom: 14px; text-align: center; }
            .footer { margin-top: 24px; font-size: 9px; color: #999; border-top: 1px solid #eee; padding-top: 6px; text-align: center; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; }
            .field { font-size: 11px; }
            .field.full { grid-column: 1 / -1; }
            .label { font-weight: 600; color: #555; margin-bottom: 2px; text-transform: uppercase; font-size: 10px; }
            .value { color: #111; white-space: pre-wrap; }
            /* The CAPEX approval row carries up to 8 signatory columns and is
               given a wide min-width for on-screen horizontal scrolling. On
               paper there is nothing to scroll into, so the last columns (FD,
               CEO) get clipped. Force the table to fit the printable width. */
            table.approval-row { table-layout: fixed !important; width: 100% !important; min-width: 0 !important; }
            table.approval-row th, table.approval-row td {
                padding: 4px 3px !important; font-size: 8px !important;
                word-break: break-word; overflow-wrap: anywhere;
            }
            table.approval-row .sig-line { height: 22px !important; }
            /* Neutralise the on-screen horizontal scroll wrapper so it cannot clip. */
            table.approval-row { display: table; }
            .preview-page-break { break-before: page; page-break-before: always; }
            @media print {
                @page { margin: 14mm; }
                body { padding: 0; }
                /* The on-screen "Page 2" divider is redundant once a real page
                   break exists — hide it in the printed/PDF output. */
                .preview-page-divider { display: none !important; }
                table.approval-row { table-layout: fixed !important; width: 100% !important; min-width: 0 !important; }
            }
        </style></head><body>${html}
        <script>window.onload = () => { setTimeout(() => window.print(), 250); };</script>
        </body></html>`);
    w.document.close();
}

export default function RequestPreviewModal({
    isOpen,
    onClose,
    mode,
    title,
    subtitle,
    sections,
    onConfirm,
    confirming = false,
    confirmLabel = 'Confirm & Submit',
    documentHeader,
}: RequestPreviewModalProps) {
    const printAreaRef = useRef<HTMLDivElement>(null);

    useSuppressToastsWhileOpen(isOpen);
    if (!isOpen) return null;

    const handlePrint = () => printPreviewDocument(printAreaRef.current, title);

    const content = (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm"
                onClick={onClose}
                aria-hidden="true"
            />
            <div className="flex min-h-full items-center justify-center p-4">
                <div
                    className="relative w-full max-w-4xl bg-white rounded-2xl shadow-2xl border border-gray-100 ring-1 ring-black/5"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-start justify-between p-5 border-b border-gray-100">
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900">
                                {mode === 'confirm' ? 'Confirm submission' : 'Request preview'}
                            </h2>
                            {mode === 'confirm' && (
                                <p className="text-sm text-gray-500 mt-1">
                                    Are you sure you want to submit this request? Please review the details below.
                                </p>
                            )}
                            {mode === 'preview' && (
                                <p className="text-sm text-gray-500 mt-1">
                                    This is how your request will appear when printed or exported to PDF.
                                </p>
                            )}
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                            aria-label="Close"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    <div className="max-h-[70vh] overflow-y-auto p-6 bg-gray-50">
                        <RequestPreviewDocument
                            ref={printAreaRef}
                            title={title}
                            subtitle={subtitle}
                            sections={sections}
                            documentHeader={documentHeader}
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3 p-5 border-t border-gray-100 bg-white rounded-b-2xl">
                        <button
                            type="button"
                            onClick={handlePrint}
                            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                            </svg>
                            Print / Save as PDF
                        </button>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                            >
                                {mode === 'confirm' ? 'Cancel' : 'Close'}
                            </button>
                            {mode === 'confirm' && (
                                <button
                                    type="button"
                                    disabled={confirming}
                                    onClick={onConfirm}
                                    className="px-5 py-2 text-sm font-semibold text-white bg-gray-900 rounded-lg hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {confirming ? 'Submitting…' : confirmLabel}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );

    if (typeof window === 'undefined') return null;
    return createPortal(content, document.body);
}
