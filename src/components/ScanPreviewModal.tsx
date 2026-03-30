'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ScanGoogleSheetResult,
  ScannedSampleRow,
  ScannedSheet,
} from '@/lib/sync/googleSheetSync';

const DATA_COLUMN_KEYS = ['Folien', 'Datum', 'von', 'bis', 'Lehrer'] as const;

const CELL_WARN_CLASS = 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90';

function isEmptyCellValue(v: unknown): boolean {
  return String(v ?? '').trim().length === 0;
}

function normalizeTwoDigitYear(y: number): number {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

/** Local calendar day; returns noon timestamp for stable ordering, or null if invalid. */
function localDayTimestamp(y: number, month0: number, day: number): number | null {
  const dt = new Date(y, month0, day);
  if (dt.getFullYear() !== y || dt.getMonth() !== month0 || dt.getDate() !== day) return null;
  return new Date(y, month0, day, 12, 0, 0, 0).getTime();
}

/**
 * Parse sheet "Datum" cells (German dd.MM.yyyy common; also ISO / slash DMY).
 * Returns a comparable local-day timestamp, or null if empty or not parseable.
 */
function parseSheetDatum(raw: string): number | null {
  const s = String(raw).trim();
  if (!s) return null;

  const head = (s.split(/\s|T/, 1)[0] ?? '').trim();

  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(head);
  if (de) {
    const d = parseInt(de[1], 10);
    const m = parseInt(de[2], 10);
    const y = normalizeTwoDigitYear(parseInt(de[3], 10));
    return localDayTimestamp(y, m - 1, d);
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(head);
  if (slash) {
    const d = parseInt(slash[1], 10);
    const m = parseInt(slash[2], 10);
    const y = normalizeTwoDigitYear(parseInt(slash[3], 10));
    return localDayTimestamp(y, m - 1, d);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    return localDayTimestamp(y, m - 1, d);
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    return localDayTimestamp(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  return null;
}

/**
 * Session rows are in teaching order; each date must be strictly after the previous row’s date
 * and strictly before the next row’s date (no duplicate session dates vs neighbors).
 * Unparseable dates are skipped (no chronology warning).
 */
function isDatumChronologyOutlier(rows: ScannedSampleRow[], rowIndex: number): boolean {
  const n = rows.length;
  if (n < 2) return false;

  const cur = parseSheetDatum(rows[rowIndex].values['Datum'] ?? '');
  if (cur === null) return false;

  const prev =
    rowIndex > 0 ? parseSheetDatum(rows[rowIndex - 1].values['Datum'] ?? '') : null;
  const next =
    rowIndex < n - 1 ? parseSheetDatum(rows[rowIndex + 1].values['Datum'] ?? '') : null;

  if (rowIndex === 0) {
    if (next === null) return false;
    return cur >= next;
  }

  if (rowIndex === n - 1) {
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

/** Row index of first non-empty cell for this student, or -1 if they never appear. */
function studentFirstAttendanceRowIndex(rows: ScannedSampleRow[], studentName: string): number {
  for (let r = 0; r < rows.length; r++) {
    if (!isEmptyCellValue(rows[r].values[studentName])) return r;
  }
  return -1;
}

/** Empty student cells before first attendance are allowed (not joined yet). */
function isStudentEmptyViolation(
  rows: ScannedSampleRow[],
  rowIndex: number,
  studentName: string
): boolean {
  const first = studentFirstAttendanceRowIndex(rows, studentName);
  if (first < 0) return false;
  return rowIndex > first && isEmptyCellValue(rows[rowIndex].values[studentName]);
}

function countSheetValidationIssues(sheet: ScannedSheet): number {
  const { sampleRows } = sheet;
  let n = 0;
  sampleRows.forEach((row, rIdx) => {
    for (const key of DATA_COLUMN_KEYS) {
      if (isEmptyCellValue(row.values[key])) n++;
    }
    if (!isEmptyCellValue(row.values['Datum']) && isDatumChronologyOutlier(sampleRows, rIdx)) {
      n++;
    }
    for (const s of sheet.headers.students) {
      if (isStudentEmptyViolation(sampleRows, rIdx, s.name)) n++;
    }
  });
  return n;
}

function validationIssuesTooltip(count: number): string {
  return `${count} validation ${count === 1 ? 'issue' : 'issues'} on this sheet (empty core cells, session date not strictly between neighbors (must be after previous and before next day), or student attendance missing after their first recorded session)`;
}

/**
 * "Current course" for preview: among sheets whose first session date is on or before today,
 * the one whose latest row with both date and teacher filled has the greatest session date.
 * Ties use the earlier tab order. Returns null if no sheet qualifies.
 */
function findCurrentCourseSheetIndex(sheets: ScannedSheet[], now: Date): number | null {
  const todayTs = localDayTimestamp(now.getFullYear(), now.getMonth(), now.getDate());
  if (todayTs === null) return null;

  let bestIdx: number | null = null;
  let bestLatestTs = -Infinity;

  sheets.forEach((sheet, idx) => {
    const rows = sheet.sampleRows;
    if (rows.length === 0) return;

    const firstTs = parseSheetDatum(rows[0].values['Datum'] ?? '');
    if (firstTs === null || firstTs > todayTs) return;

    let latestTs: number | null = null;
    for (const row of rows) {
      const dt = parseSheetDatum(row.values['Datum'] ?? '');
      if (dt === null || isEmptyCellValue(row.values['Lehrer'])) continue;
      if (latestTs === null || dt > latestTs) latestTs = dt;
    }
    if (latestTs === null) return;

    if (latestTs > bestLatestTs || (latestTs === bestLatestTs && bestIdx !== null && idx < bestIdx)) {
      bestLatestTs = latestTs;
      bestIdx = idx;
    }
  });

  return bestIdx;
}

const CURRENT_COURSE_TAB_TITLE =
  'Current course: latest session with date and teacher filled, and first session date is not in the future';

function studentAttendanceCellClass(
  text: string,
  colorStatus: 'Present' | 'Absent' | null | undefined
): string {
  const t = String(text).trim();
  const absentByText = /\babwesend\b/i.test(t) || /\babsent\b/i.test(t);
  const presentByText = t.length > 0 && !absentByText;

  if (colorStatus === 'Absent' || absentByText) {
    return 'bg-red-100/90 text-red-950 border-r border-red-200/80';
  }
  if (colorStatus === 'Present' || presentByText) {
    return 'bg-emerald-50/95 text-emerald-950 border-r border-emerald-200/70';
  }
  return 'border-r border-gray-200';
}

type ScanPreviewModalProps = {
  isOpen: boolean;
  scanResult: Extract<ScanGoogleSheetResult, { success: true }> | null;
  onClose: () => void;
  onConfirm: () => void;
  isImporting: boolean;
  /** Re-run scan for the same spreadsheet URL (e.g. after fixing the sheet in Google). */
  onResync?: () => void | Promise<void>;
  isResyncing?: boolean;
  resyncProgressMessage?: string;
  resyncError?: string;
};

export default function ScanPreviewModal({
  isOpen,
  scanResult,
  onClose,
  onConfirm,
  isImporting,
  onResync,
  isResyncing = false,
  resyncProgressMessage = '',
  resyncError = '',
}: ScanPreviewModalProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) setActiveTab(0);
  }, [isOpen, scanResult]);

  const sheetIssueCounts = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return [];
    return scanResult.sheets.map((s) => countSheetValidationIssues(s));
  }, [isOpen, scanResult, mounted]);

  const currentCourseSheetIndex = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return null;
    return findCurrentCourseSheetIndex(scanResult.sheets, new Date());
  }, [isOpen, scanResult, mounted]);

  const emptyCellCount = sheetIssueCounts[activeTab] ?? 0;
  const hasAnySheetIssues = sheetIssueCounts.some((c) => c > 0);
  const busy = isImporting || isResyncing;

  if (!isOpen || !scanResult || !mounted) return null;

  const sheets = scanResult.sheets;
  const activeSheet = sheets[activeTab];

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
            const isCurrentCourse = currentCourseSheetIndex === idx;
            const tabLabelBase =
              tabIssues > 0
                ? `${sheet.title}, ${tabIssues} validation ${tabIssues === 1 ? 'issue' : 'issues'}`
                : sheet.title;
            const tabLabel = isCurrentCourse ? `${tabLabelBase}, current course` : tabLabelBase;
            return (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={activeTab === idx}
                disabled={isResyncing}
                onClick={() => setActiveTab(idx)}
                aria-label={tabLabel}
                className={`shrink-0 rounded-t-lg border border-b-0 px-5 py-3 text-sm font-semibold whitespace-nowrap transition-colors inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                  activeTab === idx
                    ? 'relative z-[1] -mb-px border-gray-200 bg-white text-blue-600 shadow-[0_-1px_0_0_white]'
                    : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-100/80 hover:text-gray-900'
                }`}
              >
                <span className="truncate max-w-[min(40vw,20rem)]">{sheet.title}</span>
                {isCurrentCourse ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-emerald-900 ring-1 ring-emerald-400/70"
                    title={CURRENT_COURSE_TAB_TITLE}
                  >
                    <span className="material-symbols-outlined text-[1rem] leading-none" aria-hidden>
                      flag
                    </span>
                    <span>Current</span>
                  </span>
                ) : null}
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
          {activeSheet ? (
            <div className="border border-gray-200 rounded-md overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-700">
                <thead className="bg-gray-100 text-gray-600 font-semibold border-b border-gray-200">
                  <tr>
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
                      const datumChrono = isDatumChronologyOutlier(rows, rIdx);
                      const datumEmpty = isEmptyCellValue(row.values['Datum']);
                      return (
                      <tr key={rIdx} className="hover:bg-gray-50">
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['Folien']) ? CELL_WARN_CLASS : ''
                          }`}
                        >
                          {row.values['Folien'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            datumEmpty || datumChrono ? CELL_WARN_CLASS : ''
                          }`}
                          title={
                            !datumEmpty && datumChrono
                              ? 'Date must be strictly after the previous session and strictly before the next (same calendar day as a neighbor is not allowed; likely a typo)'
                              : undefined
                          }
                        >
                          {row.values['Datum'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['von']) ? CELL_WARN_CLASS : ''
                          }`}
                        >
                          {row.values['von'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['bis']) ? CELL_WARN_CLASS : ''
                          }`}
                        >
                          {row.values['bis'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['Lehrer']) ? CELL_WARN_CLASS : ''
                          }`}
                        >
                          {row.values['Lehrer'] || ''}
                        </td>
                        {activeSheet.headers.students.map((student, cIdx) => {
                          const cellText = row.values[student.name] || '';
                          const warnEmpty = isStudentEmptyViolation(rows, rIdx, student.name);
                          const tone = warnEmpty
                            ? CELL_WARN_CLASS
                            : studentAttendanceCellClass(cellText, row.studentAttendance[student.name]);
                          return (
                            <td key={cIdx} className={`px-4 py-2 ${tone}`}>
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
                        colSpan={5 + activeSheet.headers.students.length}
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
            onClick={onConfirm}
            disabled={busy || hasAnySheetIssues}
            title={
              hasAnySheetIssues && !busy
                ? 'Resolve validation issues on every sheet before importing (see yellow indicators on tabs and in the table)'
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
      </div>
    </div>,
    document.body
  );
}
