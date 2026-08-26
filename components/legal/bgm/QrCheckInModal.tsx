import { useRef, useState } from 'react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { Modal, Button } from '../../ui';
import { useToast } from '../../ui/ToastProvider';
import { Download, Copy, Link2, Mail, Send } from 'lucide-react';

/**
 * Displays a meeting's self check-in QR and lets the user:
 *  - export it for documents (PNG / vector SVG) or copy it as an image,
 *  - copy the check-in link,
 *  - email the link to specific addresses.
 */
export default function QrCheckInModal({ meetingId, url, title, onClose }: { meetingId: string; url: string; title?: string; onClose: () => void }) {
  const { addToast } = useToast();
  const canvasWrap = useRef<HTMLDivElement>(null);
  const svgWrap = useRef<HTMLDivElement>(null);
  const [copying, setCopying] = useState(false);
  const [emails, setEmails] = useState('');
  const [sending, setSending] = useState(false);

  const filename = `${(title || 'meeting').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '')}-checkin-qr`;
  const getCanvas = () => canvasWrap.current?.querySelector('canvas') as HTMLCanvasElement | null;

  const downloadPng = () => {
    const c = getCanvas();
    if (!c) return;
    c.toBlob((blob) => { if (blob) triggerDownload(URL.createObjectURL(blob), `${filename}.png`); }, 'image/png');
  };

  const downloadSvg = () => {
    const svg = svgWrap.current?.querySelector('svg');
    if (!svg) return;
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
    triggerDownload(URL.createObjectURL(blob), `${filename}.svg`);
  };

  const copyImage = async () => {
    const c = getCanvas();
    if (!c || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      addToast({ type: 'error', message: 'Copy isn’t supported in this browser — use Download instead.' });
      return;
    }
    setCopying(true);
    try {
      await new Promise<void>((resolve, reject) => {
        c.toBlob(async (blob) => {
          if (!blob) return reject(new Error('no blob'));
          try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); resolve(); }
          catch (e) { reject(e); }
        }, 'image/png');
      });
      addToast({ type: 'success', message: 'QR image copied — paste it into your document.' });
    } catch {
      addToast({ type: 'error', message: 'Couldn’t copy — use Download instead.' });
    } finally {
      setCopying(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      addToast({ type: 'success', message: 'Check-in link copied.' });
    } catch {
      addToast({ type: 'error', message: 'Couldn’t copy the link.' });
    }
  };

  const sendLink = async () => {
    const list = emails.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
    if (list.length === 0) { addToast({ type: 'error', message: 'Enter one or more email addresses.' }); return; }
    setSending(true);
    try {
      const res = await fetch(`/api/legal/bgm/meetings/${meetingId}/checkin-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails: list }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      addToast({ type: 'success', message: `Check-in link sent to ${data.sent} recipient(s).` });
      setEmails('');
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="QR self check-in" size="md">
      <div className="text-center">
        <p className="text-sm text-neutral-500 mb-4">
          Display this at the meeting, or share the link. Attendees confirm with their own signature — no login needed.
        </p>
        <div ref={canvasWrap} className="inline-block p-4 bg-white rounded-2xl border border-neutral-200">
          <QRCodeCanvas value={url} size={200} level="M" marginSize={2} />
        </div>
        <div ref={svgWrap} className="hidden" aria-hidden>
          <QRCodeSVG value={url} size={512} level="M" marginSize={2} />
        </div>

        <div className="flex flex-wrap justify-center gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={downloadPng}><Download className="w-4 h-4 mr-1.5" /> PNG</Button>
          <Button variant="outline" size="sm" onClick={downloadSvg}><Download className="w-4 h-4 mr-1.5" /> SVG</Button>
          <Button variant="outline" size="sm" onClick={copyImage} isLoading={copying}><Copy className="w-4 h-4 mr-1.5" /> Copy image</Button>
          <Button variant="outline" size="sm" onClick={copyLink}><Link2 className="w-4 h-4 mr-1.5" /> Copy link</Button>
        </div>

        {/* Send link to emails */}
        <div className="mt-5 pt-4 border-t border-border text-left">
          <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1"><Mail className="w-4 h-4" /> Email the link</label>
          <p className="text-xs text-neutral-500 mb-2">Comma-separate multiple addresses.</p>
          <div className="flex gap-2">
            <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@example.com, …"
              className="flex-1 px-3 py-2 min-h-[40px] rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <Button variant="primary" size="sm" onClick={sendLink} isLoading={sending}><Send className="w-4 h-4 mr-1.5" /> Send</Button>
          </div>
        </div>

        <a href={url} target="_blank" rel="noreferrer" className="block mt-4 text-xs text-primary-600 break-all hover:underline">{url}</a>
        <p className="mt-2 text-[11px] text-neutral-400">Check-in opens shortly before the meeting and closes after it ends.</p>
      </div>
    </Modal>
  );
}

function triggerDownload(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
