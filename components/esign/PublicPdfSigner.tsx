import { useState, useRef, useCallback, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { PDFDocument } from "pdf-lib";

// react-pdf bundles its own pinned pdfjs-dist, which trails our top-level one.
// pdf.js refuses to run against a mismatched worker, so this must be react-pdf's
// OWN worker — NOT /pdf.worker.min.mjs, which the signature editor uses for the
// newer top-level build. scripts/sync-pdfjs.js keeps both in step with
// node_modules; see its header for why they are served from public/ at all.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.react-pdf.min.mjs";

interface PublicPdfSignerProps {
  pdfUrl: string;
  signerName?: string;
  onSave: (signedPdfBlob: Blob) => void;
  onCancel: () => void;
}

interface PlacedSignature {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Standalone PDF signing component used on the *public* invitation page.
 *
 * The invitee:
 *   1. Draws a signature on a canvas (or types their name)
 *   2. Clicks anywhere on the PDF pages to drop the signature
 *   3. Submits — we flatten the signature into the PDF with pdf-lib.
 *
 * This component intentionally has *no* dependency on the authenticated
 * user's stored signature or PIN — invitees do not have accounts.
 */
export default function PublicPdfSigner({
  pdfUrl,
  signerName,
  onSave,
  onCancel,
}: PublicPdfSignerProps) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });

  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [showPad, setShowPad] = useState(true);
  const [placed, setPlaced] = useState<PlacedSignature[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(signerName || "");
  const [acknowledged, setAcknowledged] = useState(false);

  const padRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // ---- PDF loading ----
  const handleDocumentLoadSuccess = useCallback(
    ({ numPages: n }: { numPages: number }) => {
      setNumPages(n);
      fetch(pdfUrl)
        .then((r) => r.arrayBuffer())
        .then(setPdfBytes)
        .catch((err) => console.error("Failed to fetch PDF bytes:", err));
    },
    [pdfUrl]
  );

  const handlePageLoadSuccess = useCallback(
    (page: { originalWidth: number; originalHeight: number }) => {
      setPageSize({ width: page.originalWidth, height: page.originalHeight });
    },
    []
  );

  // ---- Signature pad drawing ----
  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = padRef.current!;
    const rect = c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    };
  };

  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    lastPoint.current = getPos(e);
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !padRef.current || !lastPoint.current) return;
    const ctx = padRef.current.getContext("2d");
    if (!ctx) return;
    const p = getPos(e);
    ctx.strokeStyle = "#0b1f3a";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint.current = p;
  };

  const endDraw = () => {
    drawing.current = false;
    lastPoint.current = null;
  };

  const clearPad = () => {
    const c = padRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx?.clearRect(0, 0, c.width, c.height);
  };

  const acceptSignature = () => {
    const c = padRef.current;
    if (!c) return;
    // Detect if anything was drawn
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let hasInk = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) {
        hasInk = true;
        break;
      }
    }
    if (!hasInk) {
      alert("Please draw your signature first.");
      return;
    }
    setSignatureDataUrl(c.toDataURL("image/png"));
    setShowPad(false);
  };

  // ---- Place signature on PDF page ----
  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!signatureDataUrl) return;
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const id = `sig-${Date.now()}`;
    setPlaced((prev) => [
      ...prev,
      { id, page: currentPage, x: x - 75, y: y - 25, width: 150, height: 50 },
    ]);
    setSelectedId(id);
  };

  const removePlaced = (id: string) => {
    setPlaced((prev) => prev.filter((p) => p.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // ---- Save: flatten signatures into PDF ----
  const handleSubmit = async () => {
    if (!pdfBytes) return;
    if (placed.length === 0) {
      alert("Please drop your signature on at least one page before submitting.");
      return;
    }
    if (!acknowledged) {
      alert("Please confirm you intend to sign electronically.");
      return;
    }
    setSaving(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      const sigBytes = await fetch(signatureDataUrl!).then((r) => r.arrayBuffer());
      const sigImg = await pdfDoc.embedPng(sigBytes);

      for (const el of placed) {
        const page = pages[el.page - 1];
        if (!page) continue;
        const pageH = page.getHeight();
        const pageW = page.getWidth();
        const sx = pageW / pageSize.width;
        const sy = pageH / pageSize.height;

        page.drawImage(sigImg, {
          x: el.x * sx,
          y: pageH - el.y * sy - el.height * sy,
          width: el.width * sx,
          height: el.height * sy,
        });
      }

      const out = await pdfDoc.save();
      onSave(new Blob([new Uint8Array(out)], { type: "application/pdf" }));
    } catch (e) {
      console.error("Sign error:", e);
      alert("Failed to apply signature. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // Sync canvas size to its CSS box on mount
  useEffect(() => {
    const c = padRef.current;
    if (!c) return;
    c.width = c.offsetWidth * 2;
    c.height = c.offsetHeight * 2;
  }, [showPad]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 p-3 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 disabled:opacity-40 rounded-lg"
          >
            ← Prev
          </button>
          <span className="text-sm text-gray-700 font-medium">
            Page {currentPage} of {numPages || "…"}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
            disabled={currentPage >= numPages}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 disabled:opacity-40 rounded-lg"
          >
            Next →
          </button>
          <div className="w-px h-6 bg-gray-200 mx-2" />
          <button
            onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
            className="px-2 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
          >
            −
          </button>
          <span className="text-xs text-gray-500 w-12 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={() => setScale((s) => Math.min(2.5, s + 0.1))}
            className="px-2 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
          >
            +
          </button>
        </div>

        <div className="flex items-center gap-2">
          {signatureDataUrl && (
            <button
              onClick={() => {
                setSignatureDataUrl(null);
                setShowPad(true);
                setPlaced([]);
              }}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Redraw signature
            </button>
          )}
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || placed.length === 0 || !signatureDataUrl}
            className="px-4 py-1.5 text-sm bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg disabled:opacity-40"
          >
            {saving ? "Submitting…" : "Submit signed document"}
          </button>
        </div>
      </div>

      {signatureDataUrl && (
        <div className="px-4 py-2 bg-[#F3EADC] border-b border-[#E6D3B3] text-sm text-[#3F2D19] flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Click on the document to place your signature. You can place it on multiple pages.
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 overflow-auto bg-gray-100 p-6 flex justify-center">
        <Document
          file={pdfUrl}
          onLoadSuccess={handleDocumentLoadSuccess}
          loading={
            <div className="flex items-center justify-center h-96">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
            </div>
          }
        >
          <div
            ref={pageRef}
            onClick={handlePageClick}
            className="relative shadow-xl bg-white"
            style={{ cursor: signatureDataUrl ? "crosshair" : "default" }}
          >
            <Page
              pageNumber={currentPage}
              scale={scale}
              onLoadSuccess={handlePageLoadSuccess}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
            {placed
              .filter((p) => p.page === currentPage)
              .map((p) => (
                <div
                  key={p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(p.id);
                  }}
                  style={{
                    position: "absolute",
                    left: p.x * scale,
                    top: p.y * scale,
                    width: p.width * scale,
                    height: p.height * scale,
                    border:
                      selectedId === p.id
                        ? "2px solid #2563eb"
                        : "1px dashed #94a3b8",
                    background: "rgba(255,255,255,0.5)",
                  }}
                >
                  {signatureDataUrl && (
                    <img
                      src={signatureDataUrl}
                      alt="signature"
                      className="w-full h-full object-contain pointer-events-none"
                    />
                  )}
                  {selectedId === p.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removePlaced(p.id);
                      }}
                      className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-red-500 text-white text-xs flex items-center justify-center shadow"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
          </div>
        </Document>
      </div>

      {/* Bottom acknowledgement */}
      {signatureDataUrl && (
        <div className="border-t border-gray-200 bg-white px-4 py-3 flex items-center gap-3 flex-shrink-0">
          <input
            id="ack"
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="w-4 h-4 text-primary-600 rounded"
          />
          <label htmlFor="ack" className="text-sm text-gray-700">
            I, <strong>{name || "the signer"}</strong>, agree my electronic signature is the legal
            equivalent of a handwritten signature.
          </label>
        </div>
      )}

      {/* Signature pad modal */}
      {showPad && (
        <div className="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
            <div className="px-6 pt-6 pb-3">
              <h3 className="text-lg font-semibold text-gray-900">Draw your signature</h3>
              <p className="text-sm text-gray-500">Use your mouse, finger, or stylus</p>
            </div>
            <div className="px-6">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
              <div className="border-2 border-dashed border-gray-300 rounded-xl bg-gray-50 relative">
                <canvas
                  ref={padRef}
                  className="w-full h-48 touch-none rounded-xl"
                  onPointerDown={startDraw}
                  onPointerMove={moveDraw}
                  onPointerUp={endDraw}
                  onPointerLeave={endDraw}
                />
              </div>
              <div className="flex justify-between items-center mt-2">
                <button
                  onClick={clearPad}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Clear
                </button>
                <span className="text-xs text-gray-400">Sign above the line</span>
              </div>
            </div>
            <div className="flex gap-2 p-6">
              <button
                onClick={onCancel}
                className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={acceptSignature}
                disabled={!name.trim()}
                className="flex-1 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg disabled:opacity-40"
              >
                Use this signature
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
