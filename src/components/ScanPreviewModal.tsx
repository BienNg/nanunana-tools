'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ScanGoogleSheetResult,
  ScannedSampleRow,
  ScannedSheet,
  SkippedAttendanceCellsBySheet,
  SkippedRowsBySheet,
  TeacherAliasResolution,
  WorkbookClassType,
} from '@/lib/sync/googleSheetSync';
import { GROUP_CLASS_TYPE_OPTIONS } from '@/lib/courseDuration';
import {
  findLastTaughtSessionRowIndex,
  isSheetDatumStrictlyAfterToday,
  parseSheetDatum,
} from '@/lib/sync/currentCourseSheet';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';

const DATA_COLUMN_KEYS = ['Folien', 'Datum', 'von', 'bis', 'Lehrer'] as const;

const CELL_WARN_CLASS = 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90 cursor-help';
/** Cell differs from the last imported lesson (re-import of an existing course tab). */
const CELL_UPDATE_CLASS = 'bg-sky-50 ring-1 ring-inset ring-sky-300/80 cursor-help';

const NEW_SESSION_ROW_HINT =
  'New session row: this lesson was not in the database at this position after the last import.';

/** Short hover hints for yellow cells — calm, explanatory, not alarming. */
const HINT_EMPTY_FOLIEN =
  'This cell is empty. Add the slide or lesson label so this row is complete.';
const HINT_EMPTY_DATUM =
  'No date here yet. Add the lesson date when you can — it helps keep sessions in the right order.';
const HINT_INVALID_DATUM =
  'This date format is not recognized. Use a real date (for example 11.03.2026 or 2026-03-11) so this lesson is scheduled correctly.';
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
  datumInvalid: boolean,
  datumChrono: boolean
): string | undefined {
  if (rowIsSkipped || rowOutsideValidation) return undefined;
  if (!datumEmpty && !datumInvalid && !datumChrono) return undefined;
  const parts: string[] = [];
  if (datumEmpty) parts.push(HINT_EMPTY_DATUM);
  if (datumInvalid) parts.push(HINT_INVALID_DATUM);
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
 * Unparseable dates are warning-only (no chronology warning).
 * Future session rows (Datum after local today) are excluded like skipped rows.
 */
function rowOutsideValidationScope(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): boolean {
  if (skippedRows.has(rowIndex)) return true;
  if (maxValidationRowIndex !== null && rowIndex > maxValidationRowIndex) return true;
  return isSheetDatumStrictlyAfterToday(rows[rowIndex]?.values['Datum'], now);
}

function previousActiveRowIndex(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): number {
  for (let i = rowIndex - 1; i >= 0; i--) {
    if (rowOutsideValidationScope(rows, i, skippedRows, maxValidationRowIndex, now)) continue;
    return i;
  }
  return -1;
}

function nextActiveRowIndex(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): number {
  for (let i = rowIndex + 1; i < rows.length; i++) {
    if (rowOutsideValidationScope(rows, i, skippedRows, maxValidationRowIndex, now)) continue;
    return i;
  }
  return -1;
}

function isDatumChronologyOutlier(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): boolean {
  if (rowOutsideValidationScope(rows, rowIndex, skippedRows, maxValidationRowIndex, now)) return false;
  const n = rows.length;
  if (n < 2) return false;

  const cur = parseSheetDatum(rows[rowIndex].values['Datum'] ?? '');
  if (cur === null) return false;

  const prevIdx = previousActiveRowIndex(rows, rowIndex, skippedRows, maxValidationRowIndex, now);
  const nextIdx = nextActiveRowIndex(rows, rowIndex, skippedRows, maxValidationRowIndex, now);
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
  maxValidationRowIndex: number | null,
  now: Date
): number {
  const end = maxValidationRowIndex === null ? rows.length - 1 : Math.min(rows.length - 1, maxValidationRowIndex);
  for (let r = 0; r <= end; r++) {
    if (rowOutsideValidationScope(rows, r, skippedRows, maxValidationRowIndex, now)) continue;
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
  maxValidationRowIndex: number | null,
  now: Date
): boolean {
  if (rowOutsideValidationScope(rows, rowIndex, skippedRows, maxValidationRowIndex, now)) return false;
  const first = studentFirstAttendanceRowIndex(rows, studentName, skippedRows, maxValidationRowIndex, now);
  if (first < 0) return false;
  return rowIndex > first && !studentCellHasAttendanceData(rows[rowIndex], studentName);
}

/** When re-importing an existing tab, only count validation for new sessions or cells that will change. */
function validationInReimportScope(sheet: ScannedSheet, rowIdx: number, columnKey: string): boolean {
  const d = sheet.reimportDiff;
  if (!d) return true;
  if (d.newSessionRowIndices.includes(rowIdx)) return true;
  return (d.changedCellsByRow[rowIdx] ?? []).includes(columnKey);
}

function datumChronoInReimportScope(sheet: ScannedSheet, rowIdx: number): boolean {
  const d = sheet.reimportDiff;
  if (!d) return true;
  if (d.newSessionRowIndices.includes(rowIdx)) return true;
  return (d.changedCellsByRow[rowIdx] ?? []).includes('Datum');
}

function countSheetValidationIssues(
  sheet: ScannedSheet,
  skippedRows: ReadonlySet<number>,
  skippedAttendanceCells: ReadonlySet<string>,
  maxValidationRowIndex: number | null,
  now: Date
): number {
  const { sampleRows } = sheet;
  let n = 0;
  sampleRows.forEach((row, rIdx) => {
    if (rowOutsideValidationScope(sampleRows, rIdx, skippedRows, maxValidationRowIndex, now)) return;
    for (const key of DATA_COLUMN_KEYS) {
      if (!validationInReimportScope(sheet, rIdx, key)) continue;
      if (isEmptyCellValue(row.values[key])) n++;
    }
    if (
      !isEmptyCellValue(row.values['Datum']) &&
      parseSheetDatum(row.values['Datum'] ?? '') === null &&
      validationInReimportScope(sheet, rIdx, 'Datum')
    ) {
      n++;
    }
    if (
      !isEmptyCellValue(row.values['Datum']) &&
      datumChronoInReimportScope(sheet, rIdx) &&
      isDatumChronologyOutlier(sampleRows, rIdx, skippedRows, maxValidationRowIndex, now)
    ) {
      n++;
    }
    for (const s of sheet.headers.students) {
      if (!validationInReimportScope(sheet, rIdx, s.name)) continue;
      if (skippedAttendanceCells.has(`${rIdx}:${s.name}`)) continue;
      if (isStudentEmptyViolation(sampleRows, rIdx, s.name, skippedRows, maxValidationRowIndex, now)) n++;
    }
  });
  return n;
}

function validationIssuesTooltip(count: number): string {
  return `${count} spot${count === 1 ? '' : 's'} to review on this sheet: missing core fields (Folien, date, times, teacher), a date that doesn’t line up with nearby rows, or a student column that stayed empty after their first attendance. Hover a highlighted cell for details.`;
}

function showReimportCellHighlight(
  sheet: ScannedSheet,
  rowIdx: number,
  colKey: string,
  hasValidationWarn: boolean
): boolean {
  if (!sheet.reimportDiff || hasValidationWarn) return false;
  if (sheet.reimportDiff.newSessionRowIndices.includes(rowIdx)) return false;
  return (sheet.reimportDiff.changedCellsByRow[rowIdx] ?? []).includes(colKey);
}

function reimportChangeHintText(sheet: ScannedSheet, rowIdx: number, colKey: string): string | undefined {
  return sheet.reimportDiff?.changeHintsByRow[rowIdx]?.[colKey];
}

function formatDiffColumnLabel(columnKey: string): string {
  if (columnKey === 'Folien') return 'Folien';
  if (columnKey === 'Datum') return 'Datum';
  if (columnKey === 'von') return 'Start';
  if (columnKey === 'bis') return 'End';
  if (columnKey === 'Lehrer') return 'Teacher';
  return columnKey;
}

function rowDiffSummary(sheet: ScannedSheet, rowIdx: number): string | null {
  const diff = sheet.reimportDiff;
  if (!diff) return null;
  if (diff.newSessionRowIndices.includes(rowIdx)) return 'New session row';
  const changed = diff.changedCellsByRow[rowIdx] ?? [];
  if (changed.length === 0) return null;
  const labels = changed.map(formatDiffColumnLabel);
  return `Changed: ${labels.join(', ')}`;
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
  onConfirm: (
    skippedRowsBySheet: SkippedRowsBySheet,
    skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet,
    teacherAliasResolutions: TeacherAliasResolution[],
    /** Sent to the server only when the workbook title did not imply a class type. */
    workbookClassType?: WorkbookClassType
  ) => void;
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
  const [skippedAttendanceCellsBySheet, setSkippedAttendanceCellsBySheet] = useState<SkippedAttendanceCellsBySheet>(
    {}
  );
  const [openRowActionIndex, setOpenRowActionIndex] = useState<number | null>(null);
  const [hoverHint, setHoverHint] = useState<HoverHint>(null);
  /** normalized teacher name key → existing teacher id when user maps a sheet name to a known teacher */
  const [teacherMergeByKey, setTeacherMergeByKey] = useState<Record<string, string>>({});
  /** When scan did not detect a class type from the workbook title, user must pick one. */
  const [manualWorkbookClassType, setManualWorkbookClassType] = useState<'' | WorkbookClassType>('');
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
    setSkippedAttendanceCellsBySheet({});
    setOpenRowActionIndex(null);
    setTeacherMergeByKey({});
    setManualWorkbookClassType('');
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
    const now = new Date();
    return scanResult.sheets.map((s) => {
      if (cutoff !== null && s.visibleOrderIndex > cutoff) return 0;
      const skipped = new Set(skippedRowsBySheet[makeSheetKey(s)] ?? []);
      const skippedAttendance = new Set(skippedAttendanceCellsBySheet[makeSheetKey(s)] ?? []);
      const maxValidationRowIndex =
        cutoff !== null && s.visibleOrderIndex === cutoff
          ? findLastTaughtSessionRowIndex(s.sampleRows, now)
          : null;
      return countSheetValidationIssues(s, skipped, skippedAttendance, maxValidationRowIndex, now);
    });
  }, [isOpen, scanResult, mounted, skippedRowsBySheet, skippedAttendanceCellsBySheet]);

  const currentCourseVisibleIndex = scanResult?.currentCourseVisibleIndex ?? null;

  const hasImportBlockingSheetIssues = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return false;
    return sheetIssueCounts.some((c) => c > 0);
  }, [isOpen, scanResult, mounted, sheetIssueCounts]);

  /** Block no-op reimports: every importable matched sheet has no structural changes. */
  const hasNoDetectedImportChanges = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return false;
    const cutoff = scanResult.currentCourseVisibleIndex;
    const importable = scanResult.sheets.filter((s) => cutoff === null || s.visibleOrderIndex <= cutoff);
    if (importable.length === 0) return true;
    return !importable.some((s) => {
      if (!s.reimportDiff) return true;
      return (
        s.reimportDiff.hasStructuralChanges ||
        Boolean(s.reimportDiff.pendingCompletionSync) ||
        Boolean(s.reimportDiff.syncCompletedMismatch)
      );
    });
  }, [isOpen, scanResult, mounted]);

  /** User-made skip selections are intentional import changes even when sheet diff is empty. */
  const hasManualImportSelections = useMemo(() => {
    const hasSkippedRows = Object.values(skippedRowsBySheet).some((rows) => rows.length > 0);
    if (hasSkippedRows) return true;
    return Object.values(skippedAttendanceCellsBySheet).some((cells) => cells.length > 0);
  }, [skippedRowsBySheet, skippedAttendanceCellsBySheet]);

  const resolvedWorkbookClassType: WorkbookClassType | null =
    scanResult?.workbookClassType ?? (manualWorkbookClassType === '' ? null : manualWorkbookClassType);

  /** Keep class-type picker visible whenever workbook title does not imply a class type. */
  const requiresManualWorkbookClassType = scanResult?.workbookClassType == null;

  const confirmImportBlocked =
    hasImportBlockingSheetIssues ||
    resolvedWorkbookClassType === null ||
    (hasNoDetectedImportChanges && !hasManualImportSelections);

  const emptyCellCount = sheetIssueCounts[activeTab] ?? 0;
  const busy = isImporting || isResyncing;

  const detectedNewTeachers = useMemo(() => {
    const raw = scanResult?.detectedNewTeachers ?? [];
    const byKey = new Map<string, string>();
    for (const name of raw) {
      const key = normalizePersonNameKey(name);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, name);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }, [scanResult?.detectedNewTeachers]);

  const existingTeachersForPicker = scanResult?.existingTeachersForPicker ?? [];
  const syncCompletionMismatches = useMemo(() => {
    if (!scanResult) return [];
    const cutoff = scanResult.currentCourseVisibleIndex;
    return scanResult.sheets
      .filter((sheet) => cutoff === null || sheet.visibleOrderIndex <= cutoff)
      .map((sheet) => ({ sheet, diff: sheet.reimportDiff }))
      .filter((item) => Boolean(item.diff?.syncCompletedMismatch))
      .map((item) => {
        const dbValue = Boolean(item.diff?.dbSyncCompleted);
        const analyzedValue = Boolean(item.diff?.analyzedSyncCompleted);
        return {
          title: item.sheet.title,
          dbValue,
          analyzedValue,
          reason:
            item.diff?.syncCompletedMismatchReason ??
            `Database=${dbValue ? 'completed' : 'not completed'}, review analysis=${
              analyzedValue ? 'completed' : 'not completed'
            }.`,
        };
      });
  }, [scanResult]);

  if (!isOpen || !scanResult || !mounted) return null;

  const sheets = scanResult.sheets;
  const activeSheet = sheets[activeTab];
  const activeIsFutureCourse =
    activeSheet != null &&
    currentCourseVisibleIndex !== null &&
    activeSheet.visibleOrderIndex > currentCourseVisibleIndex;

  const activeSkippedRows = activeSheet ? new Set(skippedRowsBySheet[makeSheetKey(activeSheet)] ?? []) : new Set<number>();
  const activeSkippedAttendanceCells = activeSheet
    ? new Set(skippedAttendanceCellsBySheet[makeSheetKey(activeSheet)] ?? [])
    : new Set<string>();
  const previewValidationNow = new Date();
  const activeMaxValidationRowIndex =
    activeSheet && currentCourseVisibleIndex !== null && activeSheet.visibleOrderIndex === currentCourseVisibleIndex
      ? findLastTaughtSessionRowIndex(activeSheet.sampleRows, previewValidationNow)
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
    setSkippedAttendanceCellsBySheet((prev) => {
      const before = new Set(prev[key] ?? []);
      const nextCells = [...before].filter((token) => !token.startsWith(`${rowIndex}:`));
      const next: SkippedAttendanceCellsBySheet = { ...prev };
      if (nextCells.length === 0) delete next[key];
      else next[key] = nextCells;
      return next;
    });
    setOpenRowActionIndex(null);
  };

  const toggleSkipAttendanceCell = (sheet: ScannedSheet, rowIndex: number, studentName: string) => {
    const key = makeSheetKey(sheet);
    const token = `${rowIndex}:${studentName}`;
    setSkippedAttendanceCellsBySheet((prev) => {
      const before = new Set(prev[key] ?? []);
      if (before.has(token)) before.delete(token);
      else before.add(token);
      const next: SkippedAttendanceCellsBySheet = { ...prev };
      if (before.size === 0) delete next[key];
      else next[key] = [...before].sort((a, b) => a.localeCompare(b));
      return next;
    });
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
            const hasReimportUpdates = Boolean(sheet.reimportDiff?.hasStructuralChanges);
            const hasPendingCompletionSync = Boolean(sheet.reimportDiff?.pendingCompletionSync);
            const hasSyncCompletedMismatch = Boolean(sheet.reimportDiff?.syncCompletedMismatch);
            if (hasReimportUpdates) tabLabel = `${tabLabelBase}, updates since last import`;
            if (hasPendingCompletionSync) tabLabel = `${tabLabelBase}, will be marked complete`;
            if (hasSyncCompletedMismatch) tabLabel = `${tabLabelBase}, sync completion mismatch`;
            return (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={activeTab === idx && !isFutureCourseTab}
                disabled={isResyncing || isFutureCourseTab}
                onClick={() => setActiveTab(idx)}
                aria-label={tabLabel}
                title={
                  hasSyncCompletedMismatch
                    ? sheet.reimportDiff?.syncCompletedMismatchReason ??
                      'Database completion status differs from this review analysis. Import to update sync_completed.'
                    : hasPendingCompletionSync
                    ? 'This tab is currently incomplete in the database and will be marked complete after import.'
                    : hasReimportUpdates
                      ? 'This tab matches an existing course; highlights show changes since the last import.'
                      : undefined
                }
                className={
                  isFutureCourseTab
                    ? 'shrink-0 rounded-t-lg border border-b-0 border-transparent bg-gray-100/80 px-5 py-3 text-sm font-semibold whitespace-nowrap text-gray-400 cursor-not-allowed inline-flex items-center gap-2'
                    : `shrink-0 rounded-t-lg border border-b-0 px-5 py-3 text-sm font-semibold whitespace-nowrap transition-colors inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        hasReimportUpdates && activeTab !== idx
                          ? 'border-sky-200/90 bg-sky-50/50'
                          : ''
                      } ${
                        activeTab === idx
                          ? 'relative z-[1] -mb-px border-gray-200 bg-white text-blue-600 shadow-[0_-1px_0_0_white]'
                          : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-100/80 hover:text-gray-900'
                      }`
                }
              >
                <span className="truncate max-w-[min(40vw,20rem)]">{sheet.title}</span>
                {hasReimportUpdates ? (
                  <span
                    className="inline-flex shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-950 ring-1 ring-sky-300/80"
                    aria-hidden
                  >
                    <span className="material-symbols-outlined text-sm leading-none">difference</span>
                  </span>
                ) : null}
                {hasPendingCompletionSync ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900 ring-1 ring-emerald-300/90"
                    title="Will mark this course complete on import"
                    aria-hidden
                  >
                    <span className="material-symbols-outlined text-sm leading-none">task_alt</span>
                  </span>
                ) : null}
                {hasSyncCompletedMismatch ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-amber-300/90"
                    title="Sync completed status mismatch"
                    aria-hidden
                  >
                    <span className="material-symbols-outlined text-sm leading-none">sync_problem</span>
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
          {requiresManualWorkbookClassType ? (
            <section
              className="mb-4 rounded-md border border-amber-300 bg-amber-50/90 px-4 py-3"
              role="alert"
              aria-live="polite"
            >
              <h3 className="text-sm font-semibold text-amber-950">Unknown class type</h3>
              <p className="mt-1 text-xs text-amber-900">
                The workbook title &ldquo;{scanResult.workbookTitle}&rdquo; does not contain a recognized class type.
                Choose a class type below for this import, or rename the spreadsheet / .xlsx and use{' '}
                <strong>Resync</strong>.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label htmlFor="manual-workbook-class-type" className="text-xs font-medium text-amber-950">
                  Class type
                </label>
                <select
                  id="manual-workbook-class-type"
                  value={manualWorkbookClassType}
                  onChange={(e) => {
                    const v = e.target.value;
                    setManualWorkbookClassType(v === '' ? '' : (v as WorkbookClassType));
                  }}
                  disabled={busy}
                  className="min-w-[12rem] rounded border border-amber-400/90 bg-white px-2 py-1.5 text-sm font-medium text-gray-900 shadow-sm focus:border-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
                  aria-label="Class type for this workbook"
                >
                  <option value="">Choose class type…</option>
                  {GROUP_CLASS_TYPE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          ) : null}
          {detectedNewTeachers.length > 0 ? (
            <section className="mb-4 rounded-md border border-emerald-200 bg-emerald-50/70 px-4 py-3">
              <h3 className="text-sm font-semibold text-emerald-900">New teacher names</h3>
              <p className="mt-1 text-xs text-emerald-800">
                These spellings are not matched yet (canonical name or saved alias). Choose an existing teacher to
                treat a name as an alias—it is stored and used on future imports. Otherwise a new teacher is
                created.
              </p>
              <ul className="mt-3 space-y-2" aria-label="Map new teacher names">
                {detectedNewTeachers.map((teacherName) => {
                  const nk = normalizePersonNameKey(teacherName);
                  const mergedId = teacherMergeByKey[nk];
                  const mergedLabel = mergedId
                    ? existingTeachersForPicker.find((t) => t.id === mergedId)?.name
                    : undefined;
                  return (
                    <li
                      key={nk}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200/80 bg-white/90 px-3 py-2 text-sm text-emerald-950"
                    >
                      <span className="min-w-[6rem] font-medium">{teacherName}</span>
                      <span className="text-xs text-emerald-800">→</span>
                      <select
                        value={mergedId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setTeacherMergeByKey((prev) => {
                            const next = { ...prev };
                            if (!v) delete next[nk];
                            else next[nk] = v;
                            return next;
                          });
                        }}
                        disabled={busy}
                        className="min-w-[12rem] max-w-[min(100%,20rem)] rounded border border-emerald-300/80 bg-white px-2 py-1 text-xs font-medium text-gray-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-50"
                        aria-label={`Link sheet name ${teacherName} to existing teacher`}
                      >
                        <option value="">Create new teacher</option>
                        {existingTeachersForPicker.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      {mergedLabel ? (
                        <span className="text-xs text-emerald-800">
                          Saved as alias for {mergedLabel} on import.
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
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
          {syncCompletionMismatches.length > 0 ? (
            <section className="mb-4 rounded-md border border-amber-300 bg-amber-50/90 px-4 py-3" role="alert">
              <h3 className="text-sm font-semibold text-amber-950">Sync completion mismatch detected</h3>
              <p className="mt-1 text-xs text-amber-900">
                The database `sync_completed` value differs from the current Review Import analysis for these tabs.
                You can continue with <strong>Confirm &amp; Import</strong> to update the database to the analyzed
                value.
              </p>
              <ul className="mt-2 space-y-1 text-xs text-amber-950">
                {syncCompletionMismatches.map((item) => (
                  <li
                    key={item.title}
                    className="rounded border border-amber-200/80 bg-white/70 px-2 py-1"
                    title={item.reason}
                  >
                    <span className="font-semibold">{item.title}</span>: DB is{' '}
                    <strong>{item.dbValue ? 'completed' : 'not completed'}</strong>, review analysis is{' '}
                    <strong>{item.analyzedValue ? 'completed' : 'not completed'}</strong>.
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {hasNoDetectedImportChanges && !isImporting && !isResyncing ? (
            <section className="mb-4 rounded-md border border-sky-300 bg-sky-50/90 px-4 py-3" role="status" aria-live="polite">
              <h3 className="text-sm font-semibold text-sky-950">No updates detected</h3>
              <p className="mt-1 text-xs text-sky-900">
                This import matches what is already in the database for the importable tabs. There is nothing new to
                apply, so import is disabled.
              </p>
            </section>
          ) : null}
          {isImporting || importDbLog.length > 0 ? (
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
                      const rowOutsideValidation = rowOutsideValidationScope(
                        rows,
                        rIdx,
                        activeSkippedRows,
                        activeMaxValidationRowIndex,
                        previewValidationNow
                      );
                      const datumChrono = isDatumChronologyOutlier(
                        rows,
                        rIdx,
                        activeSkippedRows,
                        activeMaxValidationRowIndex,
                        previewValidationNow
                      );
                      const datumEmpty = isEmptyCellValue(row.values['Datum']);
                      const datumInvalid = !datumEmpty && parseSheetDatum(row.values['Datum'] ?? '') === null;
                      const isNewReimportSession = Boolean(
                        activeSheet.reimportDiff?.newSessionRowIndices.includes(rIdx)
                      );
                      const changedCells = activeSheet.reimportDiff?.changedCellsByRow[rIdx] ?? [];
                      const hasRowReimportDiff = isNewReimportSession || changedCells.length > 0;
                      const rowDiffText = rowDiffSummary(activeSheet, rIdx);
                      const warnFolien =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Folien') &&
                        isEmptyCellValue(row.values['Folien']);
                      const warnDatumEmpty =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Datum') &&
                        datumEmpty;
                      const warnDatumChrono =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        datumChronoInReimportScope(activeSheet, rIdx) &&
                        !datumEmpty &&
                        !datumInvalid &&
                        datumChrono;
                      const warnDatumInvalid =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Datum') &&
                        datumInvalid;
                      const warnDatum = warnDatumEmpty || warnDatumInvalid || warnDatumChrono;
                      const warnVon =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'von') &&
                        isEmptyCellValue(row.values['von']);
                      const warnBis =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'bis') &&
                        isEmptyCellValue(row.values['bis']);
                      const warnLehrer =
                        !rowIsSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Lehrer') &&
                        isEmptyCellValue(row.values['Lehrer']);
                      return (
                      <tr
                        key={rIdx}
                        className={`hover:bg-gray-50 ${rowIsSkipped ? 'bg-gray-50/70 text-gray-400' : ''} ${
                          !rowIsSkipped && hasRowReimportDiff && activeSheet.reimportDiff
                            ? 'bg-sky-50/70'
                            : ''
                        }`}
                      >
                        <td
                          className={`px-3 py-2 border-r border-gray-200 relative ${
                            !rowIsSkipped && hasRowReimportDiff && activeSheet.reimportDiff
                              ? 'border-l-4 border-l-sky-500 bg-sky-50/60'
                              : ''
                          }`}
                        >
                          {!rowIsSkipped && rowDiffText ? (
                            <div
                              className="mb-1 inline-flex max-w-full items-center rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-950 ring-1 ring-sky-300/80"
                              title={rowDiffText}
                            >
                              <span className="truncate">{rowDiffText}</span>
                            </div>
                          ) : null}
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
                            warnFolien
                              ? CELL_WARN_CLASS
                              : showReimportCellHighlight(activeSheet, rIdx, 'Folien', warnFolien)
                                ? CELL_UPDATE_CLASS
                                : isNewReimportSession && activeSheet.reimportDiff
                                  ? 'cursor-help'
                                  : ''
                          }`}
                          {...hintHandlers(
                            warnFolien
                              ? HINT_EMPTY_FOLIEN
                              : isNewReimportSession && activeSheet.reimportDiff
                                ? NEW_SESSION_ROW_HINT
                                : reimportChangeHintText(activeSheet, rIdx, 'Folien')
                          )}
                        >
                          {normalizeDisplayCellText(row.values['Folien'])}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            warnDatum
                              ? CELL_WARN_CLASS
                              : showReimportCellHighlight(activeSheet, rIdx, 'Datum', warnDatum)
                                ? CELL_UPDATE_CLASS
                                : ''
                          }`}
                          {...hintHandlers(
                            warnDatum
                              ? datumCellHoverTitle(
                                  rowIsSkipped,
                                  rowOutsideValidation,
                                  warnDatumEmpty,
                                  warnDatumInvalid,
                                  warnDatumChrono
                                )
                              : reimportChangeHintText(activeSheet, rIdx, 'Datum')
                          )}
                        >
                          {formatDatumForDisplay(row.values['Datum'] || '')}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            warnVon
                              ? CELL_WARN_CLASS
                              : showReimportCellHighlight(activeSheet, rIdx, 'von', warnVon)
                                ? CELL_UPDATE_CLASS
                                : ''
                          }`}
                          {...hintHandlers(
                            warnVon ? HINT_EMPTY_VON : reimportChangeHintText(activeSheet, rIdx, 'von')
                          )}
                        >
                          {normalizeDisplayCellText(row.values['von'])}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            warnBis
                              ? CELL_WARN_CLASS
                              : showReimportCellHighlight(activeSheet, rIdx, 'bis', warnBis)
                                ? CELL_UPDATE_CLASS
                                : ''
                          }`}
                          {...hintHandlers(
                            warnBis ? HINT_EMPTY_BIS : reimportChangeHintText(activeSheet, rIdx, 'bis')
                          )}
                        >
                          {normalizeDisplayCellText(row.values['bis'])}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            warnLehrer
                              ? CELL_WARN_CLASS
                              : showReimportCellHighlight(activeSheet, rIdx, 'Lehrer', warnLehrer)
                                ? CELL_UPDATE_CLASS
                                : ''
                          }`}
                          {...hintHandlers(
                            warnLehrer
                              ? HINT_EMPTY_LEHRER
                              : reimportChangeHintText(activeSheet, rIdx, 'Lehrer')
                          )}
                        >
                          {normalizeDisplayCellText(row.values['Lehrer'])}
                        </td>
                        {activeSheet.headers.students.map((student, cIdx) => {
                          const cellText = normalizeDisplayCellText(row.values[student.name]);
                          const isCellSkipped = activeSkippedAttendanceCells.has(`${rIdx}:${student.name}`);
                          const studentInScope = validationInReimportScope(activeSheet, rIdx, student.name);
                          const warnEmpty =
                            !isCellSkipped &&
                            studentInScope &&
                            isStudentEmptyViolation(
                              rows,
                              rIdx,
                              student.name,
                              activeSkippedRows,
                              activeMaxValidationRowIndex,
                              previewValidationNow
                            );
                          const updateCell = showReimportCellHighlight(
                            activeSheet,
                            rIdx,
                            student.name,
                            warnEmpty
                          );
                          const tone = warnEmpty
                            ? CELL_WARN_CLASS
                            : isCellSkipped
                              ? 'bg-gray-100 text-gray-500 border-r border-gray-200'
                            : updateCell
                              ? CELL_UPDATE_CLASS
                              : studentAttendanceCellClass(cellText, row.studentAttendance[student.name]);
                          const canToggleCellSkip = !rowIsSkipped && (isCellSkipped || warnEmpty);
                          return (
                            <td
                              key={cIdx}
                              className={`px-4 py-2 ${rowIsSkipped ? 'border-r border-gray-200' : tone} ${canToggleCellSkip ? 'cursor-pointer select-none' : ''}`}
                              onClick={() => {
                                if (busy || !canToggleCellSkip) return;
                                toggleSkipAttendanceCell(activeSheet, rIdx, student.name);
                              }}
                              {...hintHandlers(
                                !rowIsSkipped && isCellSkipped
                                  ? `This attendance cell will be skipped for ${student.name} in this session. Click to include it again.`
                                  : !rowIsSkipped && warnEmpty
                                  ? hintStudentAfterFirstSession(student.name)
                                  : reimportChangeHintText(activeSheet, rIdx, student.name)
                              )}
                            >
                              {isCellSkipped ? '' : cellText}
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
            onClick={() => {
              const teacherAliasResolutions: TeacherAliasResolution[] = [];
              for (const name of detectedNewTeachers) {
                const tid = teacherMergeByKey[normalizePersonNameKey(name)];
                if (tid) teacherAliasResolutions.push({ aliasName: name, teacherId: tid });
              }
              const workbookClassTypeForApi =
                scanResult.workbookClassType == null ? resolvedWorkbookClassType ?? undefined : undefined;
              onConfirm(
                skippedRowsBySheet,
                skippedAttendanceCellsBySheet,
                teacherAliasResolutions,
                workbookClassTypeForApi
              );
            }}
            disabled={busy || confirmImportBlocked}
            title={
              !busy && resolvedWorkbookClassType === null
                ? 'Select a class type (or fix the workbook title and resync).'
                : !busy && hasNoDetectedImportChanges
                  ? 'No updates were found for importable tabs. Change the sheet and resync first.'
                : !busy && hasImportBlockingSheetIssues
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
