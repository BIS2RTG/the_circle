import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFImage } from 'pdf-lib';
import { formatDateTime } from './formatDate';

/**
 * Server-side generator for the official RTG "Capital Expenditure Form" PDF.
 *
 * Produces a plain black-and-white document that mirrors the RTG template
 * (centred logo + title, flowing "LABEL: value" lines, a flat signature block,
 * and a red Version / Issue-Date footer on every page), then appends the actual
 * uploaded quotation files as real pages — PDFs are copied page-for-page, images
 * are placed one per page.
 */

export interface CapexApproverLine {
  label: string;
  name: string;
}

export interface CapexQuoteLine {
  supplier: string;
  amount: string;
}

export interface CapexPdfData {
  unit: string;
  department: string;
  projectName: string;
  budgetType: string; // display form, e.g. "NON-BUDGETED"
  currency: string;
  budgetAmount: string;
  amountSpent: string;
  balance: string;
  projectCost: string;
  balanceAfter: string;
  justification: string;
  payback: string;
  npv: string;
  irr: string;
  evaluation: string;
  quotations: CapexQuoteLine[];
  preferredSupplier: string;
  reason: string;
  fundingSource: string;
  requestedBy: string;
  requestedByApprovers: CapexApproverLine[];
  approvedByApprovers: CapexApproverLine[];
  logo?: { bytes: Uint8Array; type: 'png' | 'jpg' } | null;
}

export interface CapexAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

// pdf-lib's standard fonts use WinAnsi (Latin-1) encoding and throw on
// characters outside it. Transliterate accents to their base letters and
// replace anything still unencodable so a stray glyph can never crash the PDF.
function san(t: unknown): string {
  return String(t ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?');
}

export async function buildCapexPdf(
  data: CapexPdfData,
  attachments: CapexAttachment[]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89; // A4
  const marginX = 58;
  const marginTop = 56;
  const marginBottom = 64;
  const black = rgb(0.07, 0.07, 0.09);
  const grey = rgb(0.3, 0.3, 0.3);
  const lineColor = rgb(0.1, 0.1, 0.1);
  const red = rgb(0.78, 0.05, 0.05);
  const size = 10.5;
  const gapY = 6;

  const pages: PDFPage[] = [];
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - marginTop;

  const w = (t: string, f: PDFFont, s: number) => f.widthOfTextAtSize(san(t), s);
  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - marginTop;
  };
  const ensure = (h: number) => {
    if (y - h < marginBottom) newPage();
  };
  const draw = (t: string, x: number, f: PDFFont, s = size, color = black) =>
    page.drawText(san(t), { x, y, size: s, font: f, color });

  // Wrap text, allowing the first line a different width than the rest (the
  // first line sits after the label; wrapped lines start at the label indent).
  const wrap = (text: string, f: PDFFont, s: number, firstMaxW: number, restMaxW: number): string[] => {
    const words = san(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    let maxW = firstMaxW;
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (w(test, f, s) > maxW && cur) {
        lines.push(cur);
        cur = word;
        maxW = restMaxW;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  // "LABEL: value" line. The value can be bold and wraps under the label if long.
  const field = (
    label: string,
    value: string,
    opts?: { valueBold?: boolean; indent?: number }
  ) => {
    const indent = opts?.indent || 0;
    const x = marginX + indent;
    ensure(size + gapY);
    draw(label, x, font);
    const afterLabelX = x + w(label, font, size) + 4;
    if (!value) {
      y -= size + gapY;
      return;
    }
    const valFont = opts?.valueBold ? bold : font;
    const inlineMaxW = PAGE_W - marginX - afterLabelX;
    if (w(value, valFont, size) <= inlineMaxW) {
      draw(value, afterLabelX, valFont);
      y -= size + gapY;
      return;
    }
    // Too long: first chunk inline (limited to the space after the label),
    // remainder wrapped under the label at the field indent.
    const lines = wrap(value, valFont, size, inlineMaxW, PAGE_W - marginX - x);
    draw(lines[0], afterLabelX, valFont);
    y -= size + gapY;
    for (let i = 1; i < lines.length; i++) {
      ensure(size + gapY);
      draw(lines[i], x, valFont);
      y -= size + gapY;
    }
  };

  const note = (t: string, indent = 0) => {
    ensure(size + gapY);
    draw(t, marginX + indent, font);
    y -= size + gapY;
  };
  const spacer = (h: number) => {
    y -= h;
  };
  const money = (v: string) => `$ ${data.currency} ${v && v.trim() ? v : 'NIL'}`;

  // ── Header: centred logo + title ──
  if (data.logo) {
    try {
      const img: PDFImage =
        data.logo.type === 'png'
          ? await pdf.embedPng(data.logo.bytes)
          : await pdf.embedJpg(data.logo.bytes);
      const maxH = 52;
      const scale = maxH / img.height;
      const imgW = img.width * scale;
      page.drawImage(img, { x: (PAGE_W - imgW) / 2, y: y - maxH, width: imgW, height: maxH });
      y -= maxH + 16;
    } catch {
      /* logo optional */
    }
  }
  {
    const title = 'CAPITAL EXPENDITURE FORM';
    const ts = 15;
    const tw = w(title, bold, ts);
    draw(title, (PAGE_W - tw) / 2, bold, ts);
    y -= ts + 22;
  }

  // ── Unit / Department on one line ──
  ensure(size + gapY);
  {
    let cx = marginX;
    draw('UNIT: ', cx, font);
    cx += w('UNIT: ', font, size);
    draw(data.unit || '-', cx, bold);
    cx += w(data.unit || '-', bold, size) + 34;
    draw('DEPARTMENT: ', cx, font);
    cx += w('DEPARTMENT: ', font, size);
    draw(data.department || '-', cx, bold);
    y -= size + gapY;
  }
  spacer(4);

  field('DESCRIPTION OF PROJECT:', data.projectName || '-', { valueBold: true });
  field('BUDGET/NON-BUDGET/ EMERGENCY:', data.budgetType || '-', { valueBold: true });
  field('BUDGET AMOUNT:', money(data.budgetAmount));
  field('AMOUNT SPENT TO DATE:', money(data.amountSpent));
  field('BALANCE:', money(data.balance));
  field('PROJECT COST:', money(data.projectCost), { valueBold: true });
  field('BALANCE AFTER THIS PURCHASE:', money(data.balanceAfter));
  field('JUSTIFICATION OF PROJECT:', data.justification || '-', { valueBold: true });
  note('(Please delete inapplicable and attach Cash Flow forecast).');
  spacer(2);
  field('EVALUATION (for profit improvement):', '');
  field('PAYBACK (Years)', data.payback || '_______________________', { indent: 36 });
  note('(Please attach workings)');
  field('NPV', data.npv || '_______________________', { indent: 36 });
  field('IRR', data.irr || '_______________________', { indent: 36 });
  field('Incremented EBITDA', data.evaluation || 'YR1_____ YR2_____ YR3_____', {
    indent: 36,
    valueBold: !!data.evaluation,
  });
  spacer(6);

  // ── Quotations (at least the standard 3 slots; more if uploaded) ──
  const quoteSlots = Math.max(3, data.quotations.length);
  for (let i = 0; i < quoteSlots; i++) {
    const q = data.quotations[i];
    ensure(size * 2 + gapY + 4);
    let cx = marginX;
    const lbl = `QUOTATION ${i + 1}: `;
    draw(lbl, cx, font);
    cx += w(lbl, font, size);
    const amt = q && q.amount ? `$ ${q.amount}` : '';
    if (amt) {
      draw(amt, cx, bold);
      cx += w(amt, bold, size);
    }
    if (q?.supplier) draw(q.supplier, cx + 30, bold);
    y -= size + 2;
    draw('NAME OF SUPPLIER', marginX + 36, font, size - 1.5, grey);
    y -= size + gapY;
  }
  spacer(2);
  field('PREFERRED QUOTATION', data.preferredSupplier || '-', { valueBold: true });
  field('REASON:', data.reason || '-', { valueBold: true });
  field('PROJECT FUNDED FROM:', data.fundingSource || '-');
  field('PROJECT REQUESTED BY:', data.requestedBy || '-');
  spacer(10);

  // ── Signature block ──
  const sigRow = (label: string, name: string) => {
    ensure(26);
    const labelW = 208;
    draw(label.toUpperCase(), marginX, font);
    const sigX = marginX + labelW;
    const sigW = 150;
    if (name) {
      const ns = size - 1;
      const nw = Math.min(w(name, font, ns), sigW);
      page.drawText(san(name), { x: sigX + (sigW - nw) / 2, y: y + 2, size: ns, font, color: black });
    }
    page.drawLine({ start: { x: sigX, y: y - 2 }, end: { x: sigX + sigW, y: y - 2 }, thickness: 0.8, color: lineColor });
    const dateX = sigX + sigW + 14;
    draw('DATE', dateX, font);
    const dLineX = dateX + w('DATE ', font, size) + 4;
    page.drawLine({
      start: { x: dLineX, y: y - 2 },
      end: { x: Math.min(dLineX + 86, PAGE_W - marginX), y: y - 2 },
      thickness: 0.8,
      color: lineColor,
    });
    y -= 24;
  };

  for (const a of data.requestedByApprovers) sigRow(a.label, a.name);
  spacer(4);
  ensure(size + 12);
  draw('PROJECT APPROVED BY:', marginX, bold);
  y -= size + 10;
  for (const a of data.approvedByApprovers) sigRow(a.label, a.name);

  // ── Footer on every form page (red Version / page no. / Issue Date) ──
  // System-generation stamp: a truthful record of when this document was
  // produced from The Circle. Sits just below the standard form footer.
  const generatedNote = `Generated from The Circle on ${formatDateTime(new Date())}`;
  pages.forEach((p, idx) => {
    const fs = 10;
    p.drawText('Version 5', { x: marginX, y: 38, size: fs, font: bold, color: red });
    const num = String(idx + 1);
    p.drawText(num, { x: PAGE_W / 2 - font.widthOfTextAtSize(num, fs) / 2, y: 38, size: fs, font, color: black });
    const issue = 'Issue Date:01 May 2026';
    p.drawText(issue, { x: PAGE_W - marginX - bold.widthOfTextAtSize(issue, fs), y: 38, size: fs, font: bold, color: red });
    const gs = 7.5;
    p.drawText(generatedNote, {
      x: PAGE_W / 2 - font.widthOfTextAtSize(generatedNote, gs) / 2,
      y: 24,
      size: gs,
      font,
      color: grey,
    });
  });

  // ── Append the actual uploaded quotation files ──
  for (const att of attachments) {
    const mime = (att.mime || '').toLowerCase();
    try {
      if (mime.includes('pdf')) {
        const src = await PDFDocument.load(att.bytes, { ignoreEncryption: true });
        const copied = await pdf.copyPages(src, src.getPageIndices());
        copied.forEach((pg) => pdf.addPage(pg));
      } else if (mime.includes('png') || mime.includes('jpg') || mime.includes('jpeg')) {
        const img = mime.includes('png') ? await pdf.embedPng(att.bytes) : await pdf.embedJpg(att.bytes);
        const ap = pdf.addPage([PAGE_W, PAGE_H]);
        ap.drawText(san(att.name), { x: marginX, y: PAGE_H - 40, size: 9, font, color: grey });
        const maxW = PAGE_W - 2 * marginX;
        const maxH = PAGE_H - 2 * marginTop;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const iw = img.width * scale;
        const ih = img.height * scale;
        ap.drawImage(img, { x: (PAGE_W - iw) / 2, y: (PAGE_H - ih) / 2 - 12, width: iw, height: ih });
      } else {
        const ap = pdf.addPage([PAGE_W, PAGE_H]);
        ap.drawText('Attached quotation (original file):', { x: marginX, y: PAGE_H - 96, size: 12, font: bold, color: black });
        ap.drawText(san(att.name), { x: marginX, y: PAGE_H - 116, size: 11, font, color: black });
      }
    } catch {
      const ap = pdf.addPage([PAGE_W, PAGE_H]);
      ap.drawText(`Could not embed attachment: ${san(att.name)}`, { x: marginX, y: PAGE_H - 96, size: 11, font, color: black });
    }
  }

  return pdf.save();
}
