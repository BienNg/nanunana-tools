'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ScanGoogleSheetResult,
  ScannedSampleRow,
  ScannedSheet,
  SkippedRowsBySheet,
} from '@/lib/sync/googleSheetSync';
import { findLastTaughtSessionRowIndex, parseSheetDatum } from '@/lib/sync/currentCourseSheet';

const DATA_COLUMN_KEYS = ['Folien', 'Datum', 'von', 'bis', 'Lehrer'] as const;

const CELL_WARN_CLASS = 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90 cursor-help';

/** Short hover hints for yellow cells — calm, explanatory, not alarming. */
const HINT_EMPTY_FOLIEN =
  'This cell is empty. Add the slide or lesson label so this row is complete.';
const HINT_EMPTY_DATUM =
  'No date here yet. Add the lesson date when you can — it helps keep sessions in the right order.';
const HINT_DATUM_ORDER =
  'This date doesn’t sit in order with the rows above and below. Each lesson should be strictly after the previous session and strictly before the next (same day as a neighbor can block import).';
const HINT_EMPTY_VON =
  'Start time is missing. Add it when this session is scheduled.';
const HINT_EMPTY_BIS =
  'End time is missing. Add it when this session is scheduled.';
const HINT_EMPTY_LEHRER =
  'Teacher name is missing. Add who led this session.';
function hintStudentAfterFirstSession(studentName: string): string {
  return `After attendance was first recorded for ${studentName}, later lessons usually need a mark or note (for example green for present, or “absent”). This cell is empty — you can fill it or skip the row if that’s intentional.`;
}

function datumCellHoverTitle(
  rowIsSkipped: boolean,
  rowOutsideValidation: boolean,
  datumEmpty: boolean,
  datumChrono: boolean
): string | undefined {
  if (rowIsSkipped || rowOutsideValidation) return undefined;
  if (!datumEmpty && !datumChrono) return undefined;
  const parts: string[] = [];
  if (datumEmpty) parts.push(HINT_EMPTY_DATUM);
  if (datumChrono) parts.push(HINT_DATUM_ORDER);
  return parts.join(' ');
}

function isEmptyCellValue(v: unknown): boolean {
  return normalizeDisplayCellText(v).length === 0;
}

function normalizeDisplayCellText(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return '';
  if (s === '[object Object]') return '';
  return s;
}

function formatDatumForDisplay(raw: string): string {
  const s = normalizeDisplayCellText(raw);
  if (!s) return '';
  const ts = parseSheetDatum(s);
  if (ts === null) return s;
  const dt = new Date(ts);
  const day = String(dt.getDate()).padStart(2, '0');
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const year = String(dt.getFullYear());
  return `${day}.${month}.${year}`;
}

/**
 * Session rows are in teaching order; each date must be strictly after the previous row’s date
 * and strictly before the next row’s date (no duplicate session dates vs neighbors).
 * Unparseable dates are skipped (no chronology warning).
 */
function previousActiveRowIndex(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null
): number {
  for (let i = rowIndex - 1; i >= 0; i--) {
    if (maxValidationRowIndex !== null && i > maxValidationRowIndex) continue;
    if (!skippedRows.has(i)) return i;
  }
  return -1;
}

function nextActiveRowIndex(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null
): number {
  for (let i = rowIndex + 1; i < rows.length; i++) {
    if (maxValidationRowIndex !== null && i > maxValidationRowIndex) continue;
    if (!skippedRows.has(i)) return i;
  }
  return -1;
}

function isDatumChronologyOutlier(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null
): boolean {
  if (skippedRows.has(rowIndex)) return false;
  if (maxValidationRowIndex !== null && rowIndex > maxValidationRowIndex) return false;
  const n = rows.length;
  if (n < 2) return false;

  const cur = parseSheetDatum(rows[rowIndex].values['Datum'] ?? '');
  if (cur === null) return false;

  const prevIdx = previousActiveRowIndex(rows, rowIndex, skippedRows, maxValidationRowIndex);
  const nextIdx = nextActiveRowIndex(rows, rowIndex, skippedRows, maxValidationRowIndex);
  const prev = prevIdx >= 0 ? parseSheetDatum(rows[prevIdx].values['Datum'] ?? '') : null;
  const next = nextIdx >= 0 ? parseSheetDatum(rows[nextIdx].values['Datum'] ?? '') : null;

  if (prevIdx < 0) {
    if (next === null) return false;
    return cur >= next;
  }

  if (nextIdx < 0) {
    if (prev === null) return false;
    return cur <= prev;
  }

  if (prev !== null && next !== null) {
    return cur <= prev || cur >= next;
  }

  if (prev !== null && next === null) return cur <= prev;
  if (prev === null && next !== null) return cur >= next;

  return false;
}

/** Sheet background color (Present / Absent) or explicit absent wording counts as attendance data — not plain feedback text alone (matches import: status comes from fill color). */
function studentCellHasAttendanceData(row: ScannedSampleRow, studentName: string): boolean {
  const a = row.studentAttendance[studentName];
  if (a === 'Present' || a === 'Absent') return true;
  const t = String(row.values[studentName] ?? '').trim();
  return /\babwesend\b/i.test(t) || /\babsent\b/i.test(t);
}

/** Row index of first cell with text or color attendance, or -1 if they never appear. */
function studentFirstAttendanceRowIndex(
  rows: ScannedSampleRow[],
  studentName: string,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null
): number {
  const end = maxValidationRowIndex === null ? rows.length - 1 : Math.min(rows.length - 1, maxValidationRowIndex);
  for (let r = 0; r <= end; r++) {
    if (skippedRows.has(r)) continue;
    if (studentCellHasAttendanceData(rows[r], studentName)) return r;
  }
  return -1;
}

/** Empty student cells before first attendance are allowed (not joined yet). */
function isStudentEmptyViolation(
  rows: ScannedSampleRow[],
  rowIndex: number,
  studentName: string,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null
): boolean {
  if (skippedRows.has(rowIndex)) return false;
  if (maxValidationRowIndex !== null && rowIndex > maxValidationRowIndex) return false;
  const first = studentFirstAttendanceRowIndex(rows, studentName, skippedRows, maxValidationRowIndex);
  if (first < 0) return false;
  return rowIndex > first && !studentCellHasAttendanceData(rows[rowIndex], studentName);
}

function countSheetValidationIssues(
  sheet: ScannedSheet,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null
): number {
  const { sampleRows } = sheet;
  let n = 0;
  sampleRows.forEach((row, rIdx) => {
    if (skippedRows.has(rIdx)) return;
    if (maxValidationRowIndex !== null && rIdx > maxValidationRowIndex) return;
    for (const key of DATA_COLUMN_KEYS) {
      if (isEmptyCellValue(row.values[key])) n++;
    }
    if (!isEmptyCellValue(row.values['Datum']) && isDatumChronologyOutlier(sampleRows, rIdx, skippedRows, maxValidationRowIndex)) {
      n++;
    }
    for (const s of sheet.headers.students) {
      if (isStudentEmptyViolation(sampleRows, rIdx, s.name, skippedRows, maxValidationRowIndex)) n++;
    }
  });
  return n;
}

function validationIssuesTooltip(count: number): string {
  return `${count} spot${count === 1 ? '' : 's'} to review on this sheet: missing core fields (Folien, date, times, teacher), a date that doesn’t line up with nearby rows, or a student column that stayed empty after their first attendance. Hover a highlighted cell for details.`;
}

function studentAttendanceCellClass(
  text: string,
  colorStatus: 'Present' | 'Absent' | null | undefined
): string {
  const t = String(text).trim();
  const absentByText = /\babwesend\b/i.test(t) || /\babsent\b/i.test(t);

  if (colorStatus === 'Absent' || absentByText) {
    return 'bg-red-100/90 text-red-950 border-r border-red-200/80';
  }
  if (colorStatus === 'Present') {
    return 'bg-emerald-50/95 text-emerald-950 border-r border-emerald-200/70';
  }
  return 'border-r border-gray-200';
}

type ScanPreviewModalProps = {
  isOpen: boolean;
  scanResult: Extract<ScanGoogleSheetResult, { success: true }> | null;
  onClose: () => void;
  onConfirm: (skippedRowsBySheet: SkippedRowsBySheet) => void;
  isImporting: boolean;
  /** Latest non-database import step (spreadsheet load, tab fetch, etc.). */
  importProgressMessage?: string;
  /** One line per completed database operation during import. */
  importDbLog?: readonly string[];
  /** Re-run scan for the same spreadsheet URL (e.g. after fixing the sheet in Google). */
  onResync?: () => void | Promise<void>;
  isResyncing?: boolean;
  resyncProgressMessage?: string;
  resyncError?: string;
};

type HoverHint = { text: string; x: number; y: number } | null;

export default function ScanPreviewModal({
  isOpen,
  scanResult,
  onClose,
  onConfirm,
  isImporting,
  importProgressMessage = '',
  importDbLog = [],
  onResync,
  isResyncing = false,
  resyncProgressMessage = '',
  resyncError = '',
}: ScanPreviewModalProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [skippedRowsBySheet, setSkippedRowsBySheet] = useState<SkippedRowsBySheet>({});
  const [openRowActionIndex, setOpenRowActionIndex] = useState<number | null>(null);
  const [hoverHint, setHoverHint] = useState<HoverHint>(null);
  const importLogScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isImporting || importDbLog.length === 0) return;
    const el = importLogScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [isImporting, importDbLog]);

  useEffect(() => {
    if (!isOpen || !scanResult) return;
    const cutoff = scanResult.currentCourseVisibleIndex;
    const list = scanResult.sheets;
    const firstImportable = list.findIndex(
      (s) => cutoff === null || s.visibleOrderIndex <= cutoff
    );
    setActiveTab(firstImportable >= 0 ? firstImportable : 0);
    setSkippedRowsBySheet({});
    setOpenRowActionIndex(null);
  }, [isOpen, scanResult]);

  useEffect(() => {
    setOpenRowActionIndex(null);
  }, [activeTab]);

  const showHint = (text: string, clientX: number, clientY: number) => {
    setHoverHint({ text, x: clientX + 14, y: clientY + 14 });
  };

  const moveHint = (clientX: number, clientY: number) => {
    setHoverHint((prev) => (prev ? { ...prev, x: clientX + 14, y: clientY + 14 } : prev));
  };

  const hideHint = () => setHoverHint(null);

  const hintHandlers = (hint: string | undefined) =>
    hint
      ? {
          onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showHint(hint, e.clientX, e.clientY),
          onMouseMove: (e: React.MouseEvent<HTMLElement>) => moveHint(e.clientX, e.clientY),
          onMouseLeave: hideHint,
          onBlur: hideHint,
        }
      : {};

  const makeSheetKey = (sheet: ScannedSheet): string => `${sheet.visibleOrderIndex}:${sheet.title}`;

  const sheetIssueCounts = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return [];
    const cutoff = scanResult.currentCourseVisibleIndex;
    return scanResult.sheets.map((s) => {
      if (cutoff !== null && s.visibleOrderIndex > cutoff) return 0;
      const skipped = new Set(skippedRowsBySheet[makeSheetKey(s)] ?? []);
      const maxValidationRowIndex =
        cutoff !== null && s.visibleOrderIndex === cutoff
          ? findLastTaughtSessionRowIndex(s.sampleRows, new Date())
          : null;
      return countSheetValidationIssues(s, skipped, maxValidationRowIndex);
    });
  }, [isOpen, scanResult, mounted, skippedRowsBySheet]);

  const currentCourseVisibleIndex = scanResult?.currentCourseVisibleIndex ?? null;

  const hasImportBlockingSheetIssues = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return false;
    return sheetIssueCounts.some((c) => c > 0);
  }, [isOpen, scanResult, mounted, sheetIssueCounts]);

  const emptyCellCount = sheetIssueCounts[activeTab] ?? 0;
  const busy = isImporting || isResyncing;

  if (!isOpen || !scanResult || !mounted) return null;

  const sheets = scanResult.sheets;
  const activeSheet = sheets[activeTab];
  const activeIsFutureCourse =
    activeSheet != null &&
    currentCourseVisibleIndex !== null &&
    activeSheet.visibleOrderIndex > currentCourseVisibleIndex;

  const activeSkippedRows = activeSheet ? new Set(skippedRowsBySheet[makeSheetKey(activeSheet)] ?? []) : new Set<number>();
  const activeMaxValidationRowIndex =
    activeSheet && currentCourseVisibleIndex !== null && activeSheet.visibleOrderIndex === currentCourseVisibleIndex
      ? findLastTaughtSessionRowIndex(activeSheet.sampleRows, new Date())
      : null;

  const toggleSkipRow = (sheet: ScannedSheet, rowIndex: number) => {
    const key = makeSheetKey(sheet);
    setSkippedRowsBySheet((prev) => {
      const before = new Set(prev[key] ?? []);
      if (before.has(rowIndex)) before.delete(rowIndex);
      else before.add(rowIndex);
      const next: SkippedRowsBySheet = { ...prev };
      if (before.size === 0) delete next[key];
      else next[key] = [...before].sort((a, b) => a - b);
      return next;
    });
    setOpenRowActionIndex(null);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-preview-title"
    >
      <div className="bg-white rounded-lg shadow-2xl w-[min(96vw,1920px)] max-h-[92vh] flex flex-col font-sans overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center gap-4 bg-gray-50">
          <h2 id="scan-preview-title" className="text-xl font-semibold text-gray-800 min-w-0 truncate">
            Review Import: {scanResult.workbookTitle}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {emptyCellCount > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-1 text-sm font-medium text-yellow-950 ring-1 ring-yellow-300/80"
                title={validationIssuesTooltip(emptyCellCount)}
              >
                <span className="material-symbols-outlined text-[1.125rem] leading-none" aria-hidden>
                  error
                </span>
                <span aria-live="polite">{emptyCellCount}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
              aria-label="Close preview"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="flex min-h-[3.25rem] items-end gap-1 border-b border-gray-200 bg-gray-50 px-6 pb-0 pt-2 overflow-x-auto no-scrollbar"
          role="tablist"
          aria-label="Workbook sheets"
        >
          {sheets.map((sheet, idx) => {
            const tabIssues = sheetIssueCounts[idx] ?? 0;
            const isCurrentCourse = sheet.visibleOrderIndex === currentCourseVisibleIndex;
            const isFutureCourseTab =
              currentCourseVisibleIndex !== null && sheet.visibleOrderIndex > currentCourseVisibleIndex;
            const tabLabelBase =
              tabIssues > 0
                ? `${sheet.title}, ${tabIssues} validation ${tabIssues === 1 ? 'issue' : 'issues'}`
                : sheet.title;
            let tabLabel = tabLabelBase;
            if (isCurrentCourse) tabLabel = `${tabLabelBase}, current course`;
            else if (isFutureCourseTab) tabLabel = `${sheet.title}, not included in this import`;
            return (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={activeTab === idx && !isFutureCourseTab}
                disabled={isResyncing || isFutureCourseTab}
                onClick={() => setActiveTab(idx)}
                aria-label={tabLabel}
                className={
                  isFutureCourseTab
                    ? 'shrink-0 rounded-t-lg border border-b-0 border-transparent bg-gray-100/80 px-5 py-3 text-sm font-semibold whitespace-nowrap text-gray-400 cursor-not-allowed inline-flex items-center gap-2'
                    : `shrink-0 rounded-t-lg border border-b-0 px-5 py-3 text-sm font-semibold whitespace-nowrap transition-colors inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        activeTab === idx
                          ? 'relative z-[1] -mb-px border-gray-200 bg-white text-blue-600 shadow-[0_-1px_0_0_white]'
                          : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-100/80 hover:text-gray-900'
                      }`
                }
              >
                <span className="truncate max-w-[min(40vw,20rem)]">{sheet.title}</span>
                {tabIssues > 0 && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-1 text-sm font-medium text-yellow-950 ring-1 ring-yellow-300/80"
                    title={validationIssuesTooltip(tabIssues)}
                  >
                    <span className="material-symbols-outlined text-[1.125rem] leading-none" aria-hidden>
                      error
                    </span>
                    <span>{tabIssues}</span>
                  </span>
                )}
              </button>
            );
          })}
          {sheets.length === 0 && (
            <div className="flex min-h-[3.25rem] items-center px-4 py-3 text-sm text-gray-500">No sheets found</div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6 bg-white">
          {isResyncing ? (
            <div
              className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950"
              role="status"
              aria-live="polite"
            >
              <span className="material-symbols-outlined animate-spin text-lg shrink-0" aria-hidden>
                sync
              </span>
              <span className="min-w-0">{resyncProgressMessage || 'Rescanning sheet…'}</span>
            </div>
          ) : null}
          {resyncError ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-950" role="alert">
              {resyncError}
            </div>
          ) : null}
          {isImporting ? (
            <div className="mb-4 space-y-3" role="status" aria-live="polite">
              {importProgressMessage ? (
                <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/90 px-4 py-2 text-sm text-amber-950">
                  <span className="material-symbols-outlined animate-spin text-lg shrink-0" aria-hidden>
                    sync
                  </span>
                  <span className="min-w-0 font-medium">{importProgressMessage}</span>
                </div>
              ) : null}
              {importDbLog.length > 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50/95">
                  <div className="border-b border-slate-200 bg-slate-100/80 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Database activity
                  </div>
                  <div
                    ref={importLogScrollRef}
                    className="max-h-[min(40vh,16rem)] overflow-y-auto px-3 py-2"
                    aria-label="Database import steps"
                  >
                    <ol className="font-mono text-[0.7rem] leading-relaxed text-slate-800 space-y-0.5 list-decimal list-inside marker:text-slate-400">
                      {importDbLog.map((line, idx) => (
                        <li key={`${idx}-${line.slice(0, 48)}`} className="break-words">
                          {line}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              ) : importProgressMessage ? null : (
                <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
                  <span className="material-symbols-outlined animate-spin text-lg shrink-0" aria-hidden>
                    sync
                  </span>
                  <span>Preparing import…</span>
                </div>
              )}
            </div>
          ) : null}
          {activeSheet && activeIsFutureCourse ? (
            <div
              className="rounded-md border border-gray-200 bg-gray-50 px-6 py-10 text-center text-sm text-gray-500"
              role="status"
            >
              This course comes after the current course in the workbook. It is not validated here and is not
              included in import.
            </div>
          ) : activeSheet ? (
            <div className="border border-gray-200 rounded-md overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-700">
                <thead className="bg-gray-100 text-gray-600 font-semibold border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-3 border-r border-gray-200 whitespace-nowrap">Actions</th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      Folien {activeSheet.headers.folien ? `(${activeSheet.headers.folien})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      Datum {activeSheet.headers.datum ? `(${activeSheet.headers.datum})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      von {activeSheet.headers.von ? `(${activeSheet.headers.von})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      bis {activeSheet.headers.bis ? `(${activeSheet.headers.bis})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      Lehrer {activeSheet.headers.lehrer.length > 0 ? `(${activeSheet.headers.lehrer.join(', ')})` : ''}
                    </th>
                    {activeSheet.headers.students.map((student, idx) => (
                      <th key={idx} className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                        {student.name} {student.letters.length > 0 ? `(${student.letters.join(', ')})` : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {activeSheet.sampleRows.length > 0 ? (
                    activeSheet.sampleRows.map((row, rIdx) => {
                      const rows = activeSheet.sampleRows;
                      const rowIsSkipped = activeSkippedRows.has(rIdx);
                      const rowOutsideValidation =
                        activeMaxValidationRowIndex !== null && rIdx > activeMaxValidationRowIndex;
                      const datumChrono = isDatumChronologyOutlier(
                        rows,
                        rIdx,
                        activeSkippedRows,
                        activeMaxValidationRowIndex
                      );
                      const datumEmpty = isEmptyCellValue(row.values['Datum']);
                      return (
                      <tr key={rIdx} className={`hover:bg-gray-50 ${rowIsSkipped ? 'bg-gray-50/70 text-gray-400' : ''}`}>
                        <td className="px-3 py-2 border-r border-gray-200 relative">
                          <button
                            type="button"
                            onClick={() =>
                              setOpenRowActionIndex((prev) => (prev === rIdx ? null : rIdx))
                            }
                            disabled={busy}
                            aria-haspopup="menu"
                            aria-expanded={openRowActionIndex === rIdx}
                            aria-label={`Actions for row ${rIdx + 1}`}
                            className="inline-flex items-center rounded border border-gray-300 bg-white px-1.5 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                          >
                            <span className="material-symbols-outlined text-base leading-none">more_vert</span>
                          </button>
                          {openRowActionIndex === rIdx ? (
                            <div
                              role="menu"
                              className="absolute left-0 top-[calc(100%+0.25rem)] z-20 min-w-[10rem] rounded-md border border-gray-200 bg-white p-1 shadow-lg"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => toggleSkipRow(activeSheet, rIdx)}
                                disabled={busy}
                                className={`flex w-full items-center rounded px-2 py-1.5 text-left text-xs font-medium transition-colors disabled:opacity-50 ${
                                  rowIsSkipped
                                    ? 'text-gray-700 hover:bg-gray-100'
                                    : 'text-amber-900 hover:bg-amber-50'
                                }`}
                              >
                                {rowIsSkipped ? 'Undo skip row' : 'Skip row'}
                              </button>
                            </div>
                          ) : null}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['Folien']) ? CELL_WARN_CLASS : ''
                          }`}
                          {...hintHandlers(
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['Folien'])
                              ? HINT_EMPTY_FOLIEN
                              : undefined
                          )}
                        >
                          {normalizeDisplayCellText(row.values['Folien'])}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            !rowIsSkipped && !rowOutsideValidation && (datumEmpty || datumChrono) ? CELL_WARN_CLASS : ''
                          }`}
                          {...hintHandlers(datumCellHoverTitle(rowIsSkipped, rowOutsideValidation, datumEmpty, datumChrono))}
                        >
                          {formatDatumForDisplay(row.values['Datum'] || '')}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['von']) ? CELL_WARN_CLASS : ''
                          }`}
                          {...hintHandlers(
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['von']) ? HINT_EMPTY_VON : undefined
                          )}
                        >
                          {normalizeDisplayCellText(row.values['von'])}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['bis']) ? CELL_WARN_CLASS : ''
                          }`}
                          {...hintHandlers(
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['bis']) ? HINT_EMPTY_BIS : undefined
                          )}
                        >
                          {normalizeDisplayCellText(row.values['bis'])}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['Lehrer']) ? CELL_WARN_CLASS : ''
                          }`}
                          {...hintHandlers(
                            !rowIsSkipped && !rowOutsideValidation && isEmptyCellValue(row.values['Lehrer'])
                              ? HINT_EMPTY_LEHRER
                              : undefined
                          )}
                        >
                          {normalizeDisplayCellText(row.values['Lehrer'])}
                        </td>
                        {activeSheet.headers.students.map((student, cIdx) => {
                          const cellText = normalizeDisplayCellText(row.values[student.name]);
                          const warnEmpty = isStudentEmptyViolation(
                            rows,
                            rIdx,
                            student.name,
                            activeSkippedRows,
                            activeMaxValidationRowIndex
                          );
                          const tone = warnEmpty
                            ? CELL_WARN_CLASS
                            : studentAttendanceCellClass(cellText, row.studentAttendance[student.name]);
                          return (
                            <td
                              key={cIdx}
                              className={`px-4 py-2 ${rowIsSkipped ? 'border-r border-gray-200' : tone}`}
                              {...hintHandlers(!rowIsSkipped && warnEmpty ? hintStudentAfterFirstSession(student.name) : undefined)}
                            >
                              {cellText}
                            </td>
                          );
                        })}
                      </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td
                        colSpan={6 + activeSheet.headers.students.length}
                        className="px-4 py-8 text-center text-gray-500"
                      >
                        No data rows found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-gray-500 text-center py-10">No data available to preview.</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          {onResync ? (
            <button
              type="button"
              onClick={() => void onResync()}
              disabled={busy}
              title="Fetch the latest data from Google Sheets using the same URL"
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {isResyncing ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                  Resyncing…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-lg">refresh</span>
                  Resync
                </>
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onConfirm(skippedRowsBySheet)}
            disabled={busy || hasImportBlockingSheetIssues}
            title={
              hasImportBlockingSheetIssues && !busy
                ? 'Resolve validation issues on every sheet through the current course before importing.'
                : undefined
            }
            className="px-6 py-2 text-sm font-medium text-white bg-[#ff7a59] rounded hover:bg-[#ff8f73] focus:ring-2 focus:ring-offset-2 focus:ring-[#ff7a59] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2 shadow-sm"
          >
            {isImporting ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                Importing...
              </>
            ) : (
              'Confirm & Import'
            )}
          </button>
        </div>
        {hoverHint ? (
          <div
            className="pointer-events-none fixed z-[300] max-w-xs rounded-md border border-slate-200 bg-slate-900/95 px-3 py-2 text-xs leading-relaxed text-white shadow-xl"
            style={{ left: hoverHint.x, top: hoverHint.y }}
            role="status"
            aria-live="polite"
          >
            {hoverHint.text}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
