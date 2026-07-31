import { useRouter } from 'next/router';
import { useRef, useState, useEffect } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { useSignatureCanvasAutosize } from '../../hooks/useSignatureCanvasAutosize';
import SignaturePadGate from '../../components/SignaturePadGate';

export default function MobileSignaturePage() {
    const router = useRouter();
    const { sessionId } = router.query;
    const sigCanvas = useRef<SignatureCanvas>(null);

    // Keep the canvas backing store matched to its CSS size (and re-sync on
    // rotation / mobile URL-bar collapse) so ink lands under the finger.
    useSignatureCanvasAutosize(() => sigCanvas.current);

    const [submitting, setSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [statusMessage, setStatusMessage] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);

    // Auto-scroll logs
    const logsEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    const addLog = (msg: string) => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [...prev, `[${time}] ${msg}`]);
        console.log(`[MobileSig] ${msg}`);
    };

    const clear = () => {
        sigCanvas.current?.clear();
        setStatusMessage('');
        addLog('Canvas cleared');
    };

    const save = async () => {
        addLog('Save button clicked');
        if (sigCanvas.current?.isEmpty()) {
            addLog('Canvas is empty, ignoring save');
            return;
        }
        if (!sessionId || typeof sessionId !== 'string') {
            addLog('Invalid sessionId: ' + JSON.stringify(sessionId));
            return;
        }

        setSubmitting(true);
        setStatusMessage('Sending signature...');

        try {
            const canvas = sigCanvas.current?.getCanvas();
            const dataURL = canvas?.toDataURL('image/png');

            if (!dataURL) {
                addLog('Error: Could not retrieve data URL from canvas');
                alert('Could not read signature image. Please try again.');
                setSubmitting(false);
                return;
            }

            const payloadSize = dataURL.length;
            addLog(`Generated info: Length=${payloadSize} chars`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                addLog('Timeout triggered (20s)');
                controller.abort();
            }, 20000);

            addLog('Starting fetch request to /api/signature/upload...');

            const start = Date.now();
            const res = await fetch('/api/signature/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    image: dataURL,
                    sessionId,
                    type: 'mobile-temp',
                }),
                signal: controller.signal,
            });

            const duration = Date.now() - start;
            addLog(`Fetch completed in ${duration}ms. Status: ${res.status} ${res.statusText}`);
            clearTimeout(timeoutId);

            let data;
            try {
                addLog('Parsing response text...');
                const text = await res.text();
                addLog(`Response body sample: ${text.substring(0, 100)}...`);

                try {
                    data = JSON.parse(text);
                } catch {
                    addLog('Error: JSON parse failed');
                    throw new Error('Invalid server response: ' + text.substring(0, 50));
                }
            } catch (e: any) {
                addLog(`Response processing error: ${e.message}`);
                throw new Error('Invalid server response');
            }

            if (!res.ok) {
                addLog(`Upload failed: ${data.message || 'Unknown server error'}`);
                throw new Error(data.message || 'Server error');
            }

            addLog('Success! Signature claimed.');
            setStatusMessage('Sent successfully.');
            setSubmitted(true);

        } catch (err: any) {
            addLog(`CATCH BLOCK: ${err.name} - ${err.message}`);
            console.error('Save error', err);

            if (err.name === 'AbortError') {
                setStatusMessage('Request timeout. Internet connection might be slow.');
            } else {
                setStatusMessage('Error: ' + (err.message || 'Failed to send signature'));
            }
        } finally {
            setSubmitting(false);
        }
    };

    if (submitted) {
        return (
            <div className="min-h-screen bg-green-50 flex items-center justify-center p-4">
                <div className="text-center space-y-4">
                    <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto text-green-600">
                        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <h1 className="text-2xl font-bold text-gray-900">Signature Sent!</h1>
                    <p className="text-gray-600">You can check your desktop screen now.</p>
                </div>
            </div>
        );
    }

    return (
        <>
            <Head>
                <title>Sign Here</title>
                <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0" />
            </Head>
            <div className="min-h-screen bg-gray-50 flex flex-col">
                <main className="flex-1 p-4 flex flex-col items-center justify-center min-h-[500px]">
                    <h1 className="text-xl font-bold text-gray-900 mb-6 font-display">Please sign below</h1>

                    {statusMessage && (
                        <div className={`w-full max-w-md mb-4 text-sm border rounded-lg px-3 py-2 transition-colors ${statusMessage.includes('timeout') || statusMessage.includes('Error') || statusMessage.includes('Failed')
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-[#F3EADC] text-[#5E4426] border-[#C9B896]'
                            }`}>
                            {statusMessage}
                        </div>
                    )}

                    <div className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-gray-200 overflow-hidden mb-6">
                        <SignaturePadGate>
                            <SignatureCanvas
                                ref={sigCanvas}
                                canvasProps={{
                                    className: 'w-full h-64 cursor-crosshair bg-white touch-none',
                                }}
                                backgroundColor="white"
                            />
                        </SignaturePadGate>
                        <div className="border-t border-gray-100 p-2 text-center text-xs text-uppercase tracking-wider text-gray-400 font-medium">
                            Draw your signature above
                        </div>
                    </div>

                    <div className="w-full max-w-md flex gap-4 mb-8">
                        <button
                            onClick={clear}
                            disabled={submitting}
                            className="flex-1 py-3 px-4 bg-white border border-gray-300 rounded-xl text-gray-700 font-medium shadow-sm hover:bg-gray-50 active:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Clear
                        </button>
                        <button
                            onClick={save}
                            disabled={submitting}
                            className="flex-1 py-3 px-4 bg-brand-600 text-white rounded-xl font-bold shadow-lg shadow-brand-500/30 hover:bg-brand-700 active:bg-brand-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {submitting && (
                                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                            )}
                            {submitting ? 'Sending...' : 'Send to Desktop'}
                        </button>
                    </div>

                    {/* Debug Log Console */}
                    <div className="w-full max-w-md mt-4">
                        <div className="text-xs text-gray-400 mb-1">Debug Log</div>
                        <div className="bg-black text-green-400 p-3 rounded-lg font-mono text-xs h-32 overflow-y-auto shadow-inner border border-gray-700">
                            {logs.length === 0 ? <span className="text-gray-600">No logs yet...</span> : logs.map((log, i) => (
                                <div key={i} className="mb-1 border-b border-gray-900 pb-1 last:border-0">{log}</div>
                            ))}
                            <div ref={logsEndRef} />
                        </div>
                    </div>
                </main>
            </div>
        </>
    );
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return { props: {} };
};
