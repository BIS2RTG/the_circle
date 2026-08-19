import type { NextApiRequest, NextApiResponse } from 'next';
import PDFDocument from 'pdfkit';
import { requireBgm } from '@/lib/bgmApi';
import { buildGovernanceDashboard, GovernanceDashboard } from '@/lib/bgmDashboard';
import { buildXlsx, SheetSpec, CellValue } from '@/lib/xlsx';

/**
 * GET /api/legal/bgm/dashboard/export?format=xlsx|pdf&year=
 * Exports the governance summary report (BGM-08) as a real .xlsx workbook or a
 * PDF summary. Mirrors the audit export convention (server-side, pdfkit for PDF).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const ctx = await requireBgm(req, res, ['bgm.reports.view']);
  if (!ctx) return;

  const year = req.query.year ? parseInt(String(req.query.year), 10) : new Date().getFullYear();
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  const stamp = `${year}_${new Date().toISOString().slice(0, 10)}`;

  let d: GovernanceDashboard;
  try { d = await buildGovernanceDashboard(ctx.organizationId, year); }
  catch (e: any) { return res.status(500).json({ error: e.message || 'Failed to build report.' }); }

  if (format === 'xlsx') {
    const sheets: SheetSpec[] = [
      {
        name: 'Summary',
        rows: [
          ['RTG Governance Report', `${year}`],
          ['Generated', fmtDateTime(d.generatedAt)],
          [],
          ['Metric', 'Value'],
          ['Active directors', d.kpis.activeDirectors],
          ['Overall attendance rate (%)', d.kpis.attendanceRate ?? '—'],
          ['Meetings held', d.kpis.meetingsHeld],
          ['Meetings scheduled', d.kpis.meetingsScheduled],
          ['Outstanding declarations', d.kpis.outstandingDeclarations],
          ['Overdue declarations', d.kpis.overdueDeclarations],
          ['Committees', d.kpis.committees],
          ['Tenure alerts', d.kpis.tenureAlerts],
          ['Tenure limit (years)', d.tenureLimitYears],
          ['Declaration completion rate (%)', d.declarations.completionRate ?? '—'],
        ],
      },
      {
        name: 'Attendance by meeting',
        rows: [['Meeting', 'Date', 'Invited', 'Attended', 'Recorded', 'Rate (%)'],
          ...d.attendance.byMeeting.map((m): CellValue[] => [m.title, fmtDate(m.date), m.invited, m.attended, m.recorded, m.rate ?? '—'])],
      },
      {
        name: 'Attendance by director',
        rows: [['Director', 'Invited', 'Attended', 'Recorded', 'Rate (%)'],
          ...d.attendance.byDirector.map((x): CellValue[] => [x.name, x.invited, x.attended, x.recorded, x.rate ?? '—'])],
      },
      {
        name: 'Committee attendance',
        rows: [['Group', 'Meetings', 'Rate (%)'],
          ...d.attendance.byCommittee.map((c): CellValue[] => [c.name, c.meetings, c.rate ?? '—'])],
      },
      {
        name: 'Director tenure',
        rows: [['Director', 'Appointed', 'Years served', 'Term ends', 'Independent', 'Status'],
          ...d.tenure.directors.map((t): CellValue[] => [t.name, t.appointed ? fmtDate(t.appointed) : '—', t.years ?? '—', t.termEnd ? fmtDate(t.termEnd) : '—', t.independent === null ? '—' : t.independent ? 'Yes' : 'No', t.status])],
      },
      {
        name: 'Declarations',
        rows: [['Declaration type', 'Issued (outstanding)', 'Submitted'],
          ...d.declarations.byType.map((t): CellValue[] => [t.label, t.issued, t.submitted]),
          [], ['Outstanding declarations'], ['Director', 'Type', 'Period', 'Due', 'Overdue'],
          ...d.declarations.outstanding.map((o): CellValue[] => [o.director, o.label, o.periodYear ?? '—', o.due ? fmtDate(o.due) : '—', o.overdue ? 'Yes' : 'No'])],
      },
      {
        name: 'Committees',
        rows: [['Committee', 'Members', 'Chair', 'Independent', 'Independent (%)'],
          ...d.committees.map((c): CellValue[] => [c.name, c.members, c.chair ?? '—', c.independent, c.independentPct ?? '—'])],
      },
      {
        name: 'Milestones',
        rows: [['Date', 'In (days)', 'Type', 'Milestone', 'Detail'],
          ...d.milestones.map((m): CellValue[] => [fmtDate(m.date), m.days, milestoneKind(m.kind), m.label, m.detail ?? ''])],
      },
    ];
    const buf = buildXlsx(sheets);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="governance_report_${stamp}.xlsx"`);
    return res.status(200).send(buf);
  }

  // ---- PDF ----
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="governance_report_${stamp}.pdf"`);
  const doc = new PDFDocument({ margin: 44, size: 'A4' });
  doc.pipe(res);

  const BROWN = '#9A7545';
  doc.fillColor(BROWN).fontSize(18).font('Helvetica-Bold').text('Rainbow Tourism Group');
  doc.fillColor('#111827').fontSize(14).text(`Board Governance Report — ${year}`);
  doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(`Generated ${fmtDateTime(d.generatedAt)}`);
  doc.moveDown(0.8);

  // KPI grid
  section(doc, 'Key indicators');
  const kpis: [string, string][] = [
    ['Active directors', String(d.kpis.activeDirectors)],
    ['Attendance rate', d.kpis.attendanceRate === null ? '—' : `${d.kpis.attendanceRate}%`],
    ['Meetings held', String(d.kpis.meetingsHeld)],
    ['Meetings scheduled', String(d.kpis.meetingsScheduled)],
    ['Outstanding declarations', String(d.kpis.outstandingDeclarations)],
    ['Overdue declarations', String(d.kpis.overdueDeclarations)],
    ['Committees', String(d.kpis.committees)],
    ['Tenure alerts', String(d.kpis.tenureAlerts)],
  ];
  const startY = doc.y;
  kpis.forEach((k, i) => {
    const col = i % 4; const rowN = Math.floor(i / 4);
    const x = doc.page.margins.left + col * 128; const y = startY + rowN * 40;
    doc.fillColor('#6b7280').fontSize(7.5).font('Helvetica').text(k[0].toUpperCase(), x, y, { width: 120 });
    doc.fillColor('#111827').fontSize(15).font('Helvetica-Bold').text(k[1], x, y + 10, { width: 120 });
  });
  doc.y = startY + Math.ceil(kpis.length / 4) * 40 + 6;
  doc.font('Helvetica');

  table(doc, 'Attendance by meeting', ['Meeting', 'Date', 'Invited', 'Att.', 'Rec.', 'Rate'],
    d.attendance.byMeeting.map((m) => [m.title, fmtDate(m.date), String(m.invited), String(m.attended), String(m.recorded), m.rate === null ? '—' : `${m.rate}%`]),
    [180, 90, 45, 40, 40, 45]);

  table(doc, 'Director tenure', ['Director', 'Appointed', 'Years', 'Term ends', 'Indep.', 'Status'],
    d.tenure.directors.map((t) => [t.name, t.appointed ? fmtDate(t.appointed) : '—', t.years === null ? '—' : String(t.years), t.termEnd ? fmtDate(t.termEnd) : '—', t.independent === null ? '—' : t.independent ? 'Yes' : 'No', cap(t.status)]),
    [150, 80, 45, 80, 45, 80]);

  table(doc, 'Outstanding declarations', ['Director', 'Type', 'Period', 'Due', 'Overdue'],
    d.declarations.outstanding.length ? d.declarations.outstanding.map((o) => [o.director, o.label, o.periodYear ? String(o.periodYear) : '—', o.due ? fmtDate(o.due) : '—', o.overdue ? 'YES' : 'No']) : [['—', 'None outstanding', '', '', '']],
    [150, 150, 55, 80, 55]);

  table(doc, 'Committee compositions', ['Committee', 'Members', 'Chair', 'Indep.', 'Indep. %'],
    d.committees.map((c) => [c.name, String(c.members), c.chair ?? '—', String(c.independent), c.independentPct === null ? '—' : `${c.independentPct}%`]),
    [170, 55, 130, 45, 55]);

  table(doc, 'Upcoming governance milestones', ['Date', 'In', 'Type', 'Milestone'],
    d.milestones.map((m) => [fmtDate(m.date), `${m.days}d`, milestoneKind(m.kind), m.label + (m.detail ? ` (${m.detail})` : '')]),
    [90, 45, 100, 260]);

  doc.end();
}

// ---- helpers ----
function section(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 30);
  doc.moveDown(0.4);
  doc.fillColor('#9A7545').fontSize(11).font('Helvetica-Bold').text(title);
  doc.moveTo(doc.page.margins.left, doc.y + 1).lineTo(doc.page.width - doc.page.margins.right, doc.y + 1).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.font('Helvetica').fillColor('#111827');
}

function table(doc: PDFKit.PDFDocument, title: string, headers: string[], rows: string[][], widths: number[]) {
  section(doc, title);
  const drawHead = () => {
    const y = doc.y; let x = doc.page.margins.left;
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#374151');
    headers.forEach((h, i) => { doc.text(h, x, y, { width: widths[i] - 4 }); x += widths[i]; });
    doc.moveDown(0.3);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + widths.reduce((a, b) => a + b, 0), doc.y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
    doc.moveDown(0.2);
    doc.font('Helvetica').fillColor('#111827').fontSize(7.5);
  };
  drawHead();
  for (const row of rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); drawHead(); }
    const rowY = doc.y; let x = doc.page.margins.left; let maxH = 0;
    row.forEach((cell, i) => {
      doc.text(cell ?? '', x, rowY, { width: widths[i] - 4 });
      maxH = Math.max(maxH, doc.heightOfString(cell ?? '', { width: widths[i] - 4 }));
      x += widths[i];
    });
    doc.y = rowY + maxH + 3;
  }
  doc.moveDown(0.3);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage();
}
function fmtDate(iso: string) { try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return iso; } }
function fmtDateTime(iso: string) { try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
function milestoneKind(k: string) { return ({ meeting: 'Meeting', declaration_due: 'Declaration', term_end: 'Term end', tenure_limit: 'Tenure' } as Record<string, string>)[k] || k; }
