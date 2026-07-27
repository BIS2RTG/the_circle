import React, { useRef, useState, useEffect } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { useSignatureCanvasAutosize } from '../hooks/useSignatureCanvasAutosize';
import { QRCodeSVG } from 'qrcode.react';
import { v4 as uuidv4 } from 'uuid';

const TabButton = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
        type="button"
        onClick={onClick}
        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${active
            ? 'bg-white text-brand-600 border-t border-x border-gray-200'
            : 'bg-gray-50 text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
    >
        {children}
    </button>
);

interface SignaturePadProps {
    initialUrl?: string;
    onSave?: (url: string) => void;
}

/** Append a unique query param so a re-saved signature isn't served from cache. */
const withCacheBust = (url: string) =>
    `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;

type StatusTone = 'info' | 'success' | 'error';

export default function SignaturePad({ initialUrl, onSave }: SignaturePadProps) {
    const [activeTab, setActiveTab] = useState<'draw' | 'upload' | 'mobile'>('draw');

    // The signature currently SAVED on the server (proxy URL, cache-busted).
    const [savedSignature, setSavedSignature] = useState<string | null>(initialUrl || null);
    // A drawn/uploaded image the user has NOT saved yet. Explicit Save persists it.
    const [pendingDataUrl, setPendingDataUrl] = useState<string | null>(null);
    // Draw tab: show the live canvas (true) vs the saved-signature preview (false).
    const [showCanvas, setShowCanvas] = useState<boolean>(!initialUrl);

    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [status, setStatus] = useState<{ tone: StatusTone; text: string } | null>(null);

    const sigCanvas = useRef<SignatureCanvas>(null);

    // Keep the canvas backing store matched to its CSS size so strokes land
    // exactly under the pen/finger.
    useSignatureCanvasAutosize(() => sigCanvas.current, [activeTab, showCanvas]);

    // The saved URL arrives asynchronously (the settings page probes storage,
    // then passes it in). Adopt it once so the preview shows without forcing a
    // remount that would wipe an in-progress drawing.
    useEffect(() => {
        if (initialUrl) {
            setSavedSignature(initialUrl);
            setShowCanvas(false);
        }
    }, [initialUrl]);

    // Mobile QR hand-off state
    const [sessionId, setSessionId] = useState<string>('');
    const [mobileUrl, setMobileUrl] = useState<string>('');
    const [isPolling, setIsPolling] = useState(false);

    useEffect(() => {
        if (activeTab === 'mobile' && !sessionId) {
            const newSessionId = uuidv4();
            setSessionId(newSessionId);
            if (typeof window !== 'undefined') {
                const configuredBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
                const baseUrl = (configuredBaseUrl && configuredBaseUrl.trim().length > 0)
                    ? configuredBaseUrl.replace(/\/$/, '')
                    : window.location.origin;
                setMobileUrl(`${baseUrl}/mobile-signature/${newSessionId}`);
            }
            setIsPolling(true);
        }
    }, [activeTab, sessionId]);

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isPolling && sessionId) {
            interval = setInterval(async () => {
                try {
                    const res = await fetch(`/api/signature/check?sessionId=${sessionId}`);
                    const data = await res.json();
                    if (data.found && data.url) {
                        setStatus({ tone: 'info', text: 'Signature received. Saving…' });
                        const claimRes = await fetch('/api/signature/claim-temp', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId }),
                        });
                        if (claimRes.ok) {
                            const claimData = await claimRes.json();
                            if (claimData.url) {
                                const fresh = withCacheBust(claimData.url);
                                setSavedSignature(fresh);
                                setPendingDataUrl(null);
                                setShowCanvas(false);
                                if (onSave) onSave(fresh);
                                setStatus({ tone: 'success', text: 'Signature saved from your phone.' });
                            } else {
                                setStatus({ tone: 'success', text: 'Signature saved.' });
                            }
                        } else {
                            setStatus({ tone: 'error', text: 'Could not save signature. Please try again.' });
                        }
                        setIsPolling(false);
                        setActiveTab('draw');
                    }
                } catch (err) {
                    console.error('Polling error', err);
                }
            }, 2000);
        }
        return () => clearInterval(interval);
    }, [isPolling, sessionId, onSave]);

    // Capture (but do NOT upload) the drawn image whenever a stroke finishes, so
    // the Save button knows there's something to save.
    const handleDrawEnd = () => {
        const c = sigCanvas.current;
        if (!c || c.isEmpty()) { setPendingDataUrl(null); return; }
        const dataURL = c.getCanvas()?.toDataURL('image/png');
        setPendingDataUrl(dataURL || null);
    };

    const clearCanvas = () => {
        sigCanvas.current?.clear();
        setPendingDataUrl(null);
    };

    // Persist an image to storage — only ever called from an explicit Save click.
    const persist = async (dataURL: string) => {
        setSaving(true);
        setStatus({ tone: 'info', text: 'Saving…' });
        try {
            const res = await fetch('/api/signature/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: dataURL }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.url) {
                const fresh = withCacheBust(data.url);
                setSavedSignature(fresh);
                setPendingDataUrl(null);
                setShowCanvas(false);
                if (onSave) onSave(fresh);
                setStatus({ tone: 'success', text: 'Signature saved.' });
            } else {
                setStatus({ tone: 'error', text: data?.message || data?.error || 'Failed to save signature.' });
            }
        } catch (err) {
            console.error('Save error', err);
            setStatus({ tone: 'error', text: "Couldn't save your signature. Please check your connection and try again." });
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        setStatus({ tone: 'info', text: 'Removing…' });
        try {
            const res = await fetch('/api/user/signature', { method: 'DELETE' });
            if (res.ok) {
                setSavedSignature(null);
                setPendingDataUrl(null);
                setShowCanvas(true);
                clearCanvas();
                if (onSave) onSave('');
                setStatus({ tone: 'success', text: 'Signature deleted.' });
            } else {
                const d = await res.json().catch(() => ({}));
                setStatus({ tone: 'error', text: d?.error || 'Failed to delete signature.' });
            }
        } catch (err) {
            console.error('Delete error', err);
            setStatus({ tone: 'error', text: "Couldn't delete your signature. Please check your connection and try again." });
        } finally {
            setDeleting(false);
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setStatus({ tone: 'error', text: 'Please choose an image file (PNG or JPG).' });
            return;
        }
        if (file.size > 4 * 1024 * 1024) {
            setStatus({ tone: 'error', text: 'Image must be under 4MB.' });
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            const base64 = event.target?.result as string;
            if (base64) {
                // Stage a preview; the user saves explicitly.
                setPendingDataUrl(base64);
                setStatus(null);
            }
        };
        reader.readAsDataURL(file);
        // Allow re-selecting the same file later.
        e.target.value = '';
    };

    const statusClasses: Record<StatusTone, string> = {
        info: 'bg-gray-50 border-gray-200 text-gray-700',
        success: 'bg-success-50 border-success-200 text-success-700',
        error: 'bg-danger-50 border-danger-200 text-danger-700',
    };

    const SaveButton = ({ onClick, label = 'Save signature' }: { onClick: () => void; label?: string }) => (
        <button
            type="button"
            onClick={onClick}
            disabled={saving}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
            {saving ? 'Saving…' : label}
        </button>
    );

    return (
        <div className="w-full bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="flex border-b border-gray-200 px-4 pt-4 gap-2 bg-gray-50/50">
                <TabButton active={activeTab === 'draw'} onClick={() => setActiveTab('draw')}>
                    <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        Draw
                    </span>
                </TabButton>
                <TabButton active={activeTab === 'upload'} onClick={() => setActiveTab('upload')}>
                    <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                        Upload
                    </span>
                </TabButton>
                <TabButton active={activeTab === 'mobile'} onClick={() => setActiveTab('mobile')}>
                    <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                        Mobile
                    </span>
                </TabButton>
            </div>

            <div className="p-6">
                {/* DRAW ---------------------------------------------------------- */}
                {activeTab === 'draw' && (
                    savedSignature && !showCanvas ? (
                        <div className="space-y-4">
                            <div className="relative h-56 sm:h-64 w-full flex items-center justify-center bg-gray-50 border border-gray-200 rounded-lg">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={savedSignature} alt="Your saved signature" className="max-h-full max-w-full" />
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-success-600 font-medium flex items-center gap-1">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                    Signature on file
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => { setShowCanvas(true); setPendingDataUrl(null); setStatus(null); }}
                                        className="px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                                    >
                                        Replace
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleDelete}
                                        disabled={deleting}
                                        className="px-3 py-2 text-sm font-medium rounded-lg border border-danger-300 text-danger-600 hover:bg-danger-50 disabled:opacity-60 transition-colors"
                                    >
                                        {deleting ? 'Deleting…' : 'Delete'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="border border-gray-200 rounded-lg bg-white relative">
                                <SignatureCanvas
                                    ref={sigCanvas}
                                    onEnd={handleDrawEnd}
                                    canvasProps={{
                                        // Taller drawing area so signatures aren't cramped; the
                                        // autosize hook keeps the backing store in sync.
                                        className: 'w-full h-56 sm:h-64 cursor-crosshair rounded-lg touch-none',
                                        // touch-action:none stops the page from
                                        // scrolling when a finger/pen lands on the pad;
                                        // overscroll containment stops any bounce.
                                        style: { touchAction: 'none', overscrollBehavior: 'contain' },
                                    }}
                                    backgroundColor="rgba(255, 255, 255, 0)"
                                />
                                {!pendingDataUrl && (
                                    <div className="absolute top-2 right-2 text-xs text-gray-300 pointer-events-none">Sign here</div>
                                )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <button
                                    type="button"
                                    onClick={clearCanvas}
                                    className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Clear
                                </button>
                                <div className="flex items-center gap-2">
                                    {savedSignature && (
                                        <button
                                            type="button"
                                            onClick={() => { setShowCanvas(false); clearCanvas(); setStatus(null); }}
                                            className="px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                    )}
                                    <SaveButton onClick={() => { if (pendingDataUrl) void persist(pendingDataUrl); }} />
                                </div>
                            </div>
                            <p className="text-xs text-gray-400">Draw your signature above, then press <span className="font-medium text-gray-500">Save signature</span>.</p>
                        </div>
                    )
                )}

                {/* UPLOAD -------------------------------------------------------- */}
                {activeTab === 'upload' && (
                    pendingDataUrl ? (
                        <div className="space-y-4">
                            <div className="h-56 sm:h-64 w-full flex items-center justify-center bg-gray-50 border border-gray-200 rounded-lg">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={pendingDataUrl} alt="Signature preview" className="max-h-full max-w-full" />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={() => { setPendingDataUrl(null); setStatus(null); }}
                                    className="px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                                >
                                    Choose different
                                </button>
                                <SaveButton onClick={() => { if (pendingDataUrl) void persist(pendingDataUrl); }} />
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-gray-200 rounded-lg bg-gray-50/50">
                            <div className="mb-4 p-3 bg-brand-50 rounded-full text-brand-600">
                                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                            </div>
                            <p className="text-sm font-medium text-gray-900 mb-1">Upload an image</p>
                            <p className="text-xs text-gray-500 mb-4">PNG, JPG up to 4MB</p>
                            <label className="relative cursor-pointer">
                                <span className="px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50">
                                    Choose File
                                </span>
                                <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
                            </label>
                        </div>
                    )
                )}

                {/* MOBILE -------------------------------------------------------- */}
                {activeTab === 'mobile' && (
                    <div className="flex flex-col sm:flex-row items-center gap-8 justify-center py-4">
                        <div className="bg-white p-2 rounded-xl shadow-sm border border-gray-100">
                            <QRCodeSVG value={mobileUrl} size={160} />
                        </div>
                        <div className="text-center sm:text-left max-w-xs">
                            <h4 className="font-semibold text-gray-900">Sign on your phone</h4>
                            <p className="text-sm text-gray-500 mt-1 mb-4">
                                Scan the QR code with your mobile device to open the signature pad. It saves automatically once you sign.
                            </p>
                            <div className="text-xs px-3 py-2 bg-[#F3EADC] text-[#5E4426] rounded-lg flex items-center gap-2 justify-center sm:justify-start">
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#C9A574] opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[#9A7545]"></span>
                                </span>
                                Waiting for device…
                            </div>
                        </div>
                    </div>
                )}

                {/* Status line — below the content so it never shifts the pad while
                    you're mid-signature. */}
                {status && (
                    <div className={`mt-4 text-sm border rounded-lg px-3 py-2 ${statusClasses[status.tone]}`}>
                        {status.text}
                    </div>
                )}
            </div>
        </div>
    );
}
