'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ScanGoogleSheetResult,
  ScannedSheet,
  SkippedAttendanceCellsBySheet,
  SkippedRowsBySheet,
  TeacherAliasResolution,
  SyncGroupApplySummary,
  WorkbookClassType,
} from '@/lib/sync/googleSheetSync';
import type { StudentAliasResolution } from '@/lib/sync/googleSheetStudentSync';
import {
  REVIEW_TEACHER_MERGE_CREATE_NEW,
  buildTeacherImportReviewPayload,
  teacherMergeDecisionError,
} from '@/lib/sync/googleSheetTeacherSync';
import { GROUP_CLASS_TYPE_OPTIONS } from '@/lib/courseDuration';
import {
  findLastTaughtSessionRowIndex,
  isSheetDatumStrictlyAfterToday,
  isSheetDatumOnOrBeforeToday,
  parseSheetDatum,
} from '@/lib/sync/currentCourseSheet';
import {
  isDatumChronologyOutlier,
  rowOutsideChronologyValidationTarget,
} from '@/lib/sync/sheetSessionDatumChronology';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import {
  countSheetValidationIssues,
  datumChronoInReimportScope,
  isEmptyCellValue,
  isStudentEmptyViolation,
  normalizeDisplayCellText,
  rowOutsideValidationScope,
  sampleRowsDatumChronologyScope,
  sheetHasRemainingStructuralDiff,
  trailingNoDateTeacherSessionRows,
  validationInReimportScope,
} from '@/lib/sync/reviewImportValidation';

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
const HINT_LEHRER_PAST_OR_TODAY =
  'This lesson’s date is today or in the past, but no teacher is set. Add who led this session.';
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
  if (rowIsSkipped) return undefined;
  if (!datumEmpty && !datumInvalid && !datumChrono) return undefined;
  if (rowOutsideValidation && !datumChrono) return undefined;
  const parts: string[] = [];
  if (datumEmpty) parts.push(HINT_EMPTY_DATUM);
  if (datumInvalid) parts.push(HINT_INVALID_DATUM);
  if (datumChrono) parts.push(HINT_DATUM_ORDER);
  return parts.join(' ');
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

function isDatabaseMutationLogLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (/\b(insert|upsert|update|delete|enroll)\b/.test(lower)) return true;
  if (lower.includes('sync_completed=')) return true;
  // Attendance summary lines use +/~/- counters instead of action verbs.
  return /attendance\s+—\s+\+\d+\s+~\d+\s+[−-]\d+/i.test(line);
}

type ScanSuccess = Extract<ScanGoogleSheetResult, { success: true }>;

type ScanPreviewModalProps = {
  isOpen: boolean;
  scanResult: ScanSuccess | null;
  /**
   * When batch-updating groups, pass every successful scan so "Update all groups" stays disabled until
   * each tab’s new-teacher dropdowns are resolved (not only the active group).
   */
  batchScanResultsByGroup?: Record<string, ScanSuccess> | null;
  onClose: () => void;
  onConfirm: (
    skippedRowsBySheet: SkippedRowsBySheet,
    skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet,
    teacherAliasResolutions: TeacherAliasResolution[],
    studentAliasResolutions: StudentAliasResolution[],
    newTeacherCreateAcknowledgements: string[],
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
  /** Import finished once; require a fresh resync before allowing another import. */
  importRequiresResync?: boolean;
  groupTabs?: {
    id: string;
    label: string;
    disabled?: boolean;
    /** From scan: new/changed session rows (see tooltip). */
    detectedChangeCount?: number;
    detectedChangeTooltip?: string;
  }[];
  activeGroupTabId?: string;
  onSelectGroupTab?: (groupId: string) => void;
  onConfirmAllGroups?: (
    skippedRowsBySheet: SkippedRowsBySheet,
    skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet,
    teacherAliasResolutions: TeacherAliasResolution[],
    studentAliasResolutions: StudentAliasResolution[],
    newTeacherCreateAcknowledgements: string[],
    workbookClassType?: WorkbookClassType,
    /** Per-group review state so batch import keeps skips and alias picks from every group tab. */
    reviewStateByGroupId?: Record<string, ReviewImportSlice>
  ) => void;
  isImportingAllGroups?: boolean;
  isConfirmAllGroupsDisabled?: boolean;
  importApplySummary?: SyncGroupApplySummary | null;
};

type HoverHint = { text: string; x: number; y: number } | null;

/** Stable empty maps so `?? {}` does not break memo deps with a new object each render. */
const EMPTY_SKIPPED_ROWS: SkippedRowsBySheet = {};
const EMPTY_SKIPPED_ATTENDANCE: SkippedAttendanceCellsBySheet = {};
const EMPTY_TEACHER_MERGE: Record<string, string> = {};
const EMPTY_STUDENT_MERGE: Record<string, string> = {};

export type ReviewImportSlice = {
  activeTab: number;
  skippedRowsBySheet: SkippedRowsBySheet;
  skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet;
  teacherMergeByKey: Record<string, string>;
  studentMergeByKey: Record<string, string>;
  manualWorkbookClassType: '' | WorkbookClassType;
};

function emptyReviewSlice(activeTab = 0): ReviewImportSlice {
  return {
    activeTab,
    skippedRowsBySheet: {},
    skippedAttendanceCellsBySheet: {},
    teacherMergeByKey: {},
    studentMergeByKey: {},
    manualWorkbookClassType: '',
  };
}

function makeReviewSheetKey(sheet: ScannedSheet): string {
  return `${sheet.visibleOrderIndex}:${sheet.title}`;
}

/** Sheet keys where structural row skips match the course tab "completed" / green-dot logic. */
function sheetKeysWithStructuralSkipsForReview(
  sheets: readonly ScannedSheet[],
  cutoff: number | null,
  skippedRowsBySheet: SkippedRowsBySheet,
  now: Date
): Set<string> {
  const out = new Set<string>();
  for (const s of sheets) {
    if (cutoff !== null && s.visibleOrderIndex > cutoff) continue;
    const skipped = new Set(skippedRowsBySheet[makeReviewSheetKey(s)] ?? []);
    const trailingNoDateTeacherRows = trailingNoDateTeacherSessionRows(s.sampleRows);
    const maxValidationRowIndex =
      cutoff !== null && s.visibleOrderIndex === cutoff
        ? findLastTaughtSessionRowIndex(s.sampleRows, now)
        : null;
    for (let rIdx = 0; rIdx < s.sampleRows.length; rIdx++) {
      if (
        rowOutsideValidationScope(
          s.sampleRows,
          rIdx,
          skipped,
          trailingNoDateTeacherRows,
          maxValidationRowIndex,
          now
        )
      ) {
        out.add(makeReviewSheetKey(s));
        break;
      }
    }
  }
  return out;
}

/**
 * First importable sheet that is not completed in the review UI; if all importable sheets are completed, the last importable index.
 */
function preferredCourseTabIndexForScan(
  scanResult: Extract<ScanGoogleSheetResult, { success: true }>,
  skippedRowsBySheet: SkippedRowsBySheet,
  now: Date
): number {
  const sheets = scanResult.sheets;
  const cutoff = scanResult.currentCourseVisibleIndex;
  const skipKeys = sheetKeysWithStructuralSkipsForReview(sheets, cutoff, skippedRowsBySheet, now);
  const importableIndices: number[] = [];
  for (let idx = 0; idx < sheets.length; idx++) {
    const s = sheets[idx];
    if (cutoff !== null && s.visibleOrderIndex > cutoff) continue;
    importableIndices.push(idx);
  }
  if (importableIndices.length === 0) return 0;
  for (const idx of importableIndices) {
    const s = sheets[idx]!;
    const analyzedCourseCompleted = Boolean(s.analyzedSyncCompleted);
    const hasSkippedRows = skipKeys.has(makeReviewSheetKey(s));
    const isCourseCompleted = analyzedCourseCompleted && !hasSkippedRows;
    if (!isCourseCompleted) return idx;
  }
  return importableIndices[importableIndices.length - 1]!;
}

export default function ScanPreviewModal({
  isOpen,
  scanResult,
  batchScanResultsByGroup = null,
  onClose,
  onConfirm,
  isImporting,
  importProgressMessage = '',
  importDbLog = [],
  onResync,
  isResyncing = false,
  resyncProgressMessage = '',
  resyncError = '',
  importRequiresResync = false,
  groupTabs = [],
  activeGroupTabId,
  onSelectGroupTab,
  onConfirmAllGroups,
  isImportingAllGroups = false,
  isConfirmAllGroupsDisabled = false,
  importApplySummary = null,
}: ScanPreviewModalProps) {
  const [mounted, setMounted] = useState(false);
  /**
   * Per–group-tab review state when `onSelectGroupTab` is used (bulk update modal); otherwise only `_single` is used.
   * Switching group tabs must not clear skips / merges / sheet tab index for other groups.
   */
  const [reviewSlicesByKey, setReviewSlicesByKey] = useState<Record<string, ReviewImportSlice>>({});
  const [openRowActionIndex, setOpenRowActionIndex] = useState<number | null>(null);
  const [hoverHint, setHoverHint] = useState<HoverHint>(null);
  const prevActiveGroupTabIdRef = useRef<string | undefined>(undefined);
  const persistPerGroupReview = Boolean(onSelectGroupTab);
  const reviewStorageKey = persistPerGroupReview ? (activeGroupTabId ?? '__none__') : '_single';

  const updateReviewSlice = useCallback(
    (updater: (slice: ReviewImportSlice) => ReviewImportSlice) => {
      setReviewSlicesByKey((prev) => {
        const key = persistPerGroupReview ? (activeGroupTabId ?? '__none__') : '_single';
        const cur = prev[key] ?? emptyReviewSlice();
        return { ...prev, [key]: updater(cur) };
      });
    },
    [persistPerGroupReview, activeGroupTabId]
  );

  const activeReviewSlice = reviewSlicesByKey[reviewStorageKey];
  const activeTab = activeReviewSlice?.activeTab ?? 0;
  const skippedRowsBySheet = activeReviewSlice?.skippedRowsBySheet ?? EMPTY_SKIPPED_ROWS;
  const skippedAttendanceCellsBySheet =
    activeReviewSlice?.skippedAttendanceCellsBySheet ?? EMPTY_SKIPPED_ATTENDANCE;
  const teacherMergeByKey = activeReviewSlice?.teacherMergeByKey ?? EMPTY_TEACHER_MERGE;
  const studentMergeByKey = activeReviewSlice?.studentMergeByKey ?? EMPTY_STUDENT_MERGE;
  const manualWorkbookClassType = activeReviewSlice?.manualWorkbookClassType ?? '';

  const importLogScrollRef = useRef<HTMLDivElement | null>(null);
  const importMutationDbLog = useMemo(
    () => importDbLog.filter((line) => isDatabaseMutationLogLine(line)),
    [importDbLog]
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isImporting || importMutationDbLog.length === 0) return;
    const el = importLogScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [isImporting, importMutationDbLog]);

  useEffect(() => {
    if (!isOpen || !scanResult) return;
    const preferred = preferredCourseTabIndexForScan(scanResult, {}, new Date());
    setReviewSlicesByKey((prev) => {
      const key = persistPerGroupReview ? (activeGroupTabId ?? '__none__') : '_single';
      if (persistPerGroupReview) {
        if (prev[key]) return prev;
        return { ...prev, [key]: emptyReviewSlice(preferred) };
      }
      return { ...prev, _single: emptyReviewSlice(preferred) };
    });
    setOpenRowActionIndex(null);
  }, [isOpen, scanResult, persistPerGroupReview, activeGroupTabId]);

  useEffect(() => {
    if (!isOpen) {
      prevActiveGroupTabIdRef.current = undefined;
      return;
    }
    if (!scanResult || !persistPerGroupReview || activeGroupTabId == null) return;
    const prevGid = prevActiveGroupTabIdRef.current;
    if (prevGid === activeGroupTabId) return;
    prevActiveGroupTabIdRef.current = activeGroupTabId;
    setReviewSlicesByKey((state) => {
      const slice = state[activeGroupTabId] ?? emptyReviewSlice();
      const preferred = preferredCourseTabIndexForScan(scanResult, slice.skippedRowsBySheet, new Date());
      if (slice.activeTab === preferred) return state;
      return { ...state, [activeGroupTabId]: { ...slice, activeTab: preferred } };
    });
  }, [isOpen, scanResult, persistPerGroupReview, activeGroupTabId]);

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
      const trailingNoDateTeacherRows = trailingNoDateTeacherSessionRows(s.sampleRows);
      const maxValidationRowIndex =
        cutoff !== null && s.visibleOrderIndex === cutoff
          ? findLastTaughtSessionRowIndex(s.sampleRows, now)
          : null;
      return countSheetValidationIssues(
        s,
        skipped,
        skippedAttendance,
        trailingNoDateTeacherRows,
        maxValidationRowIndex,
        now
      );
    });
  }, [isOpen, scanResult, mounted, skippedRowsBySheet, skippedAttendanceCellsBySheet]);

  const sheetHasSkippedSessionRows = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return new Set<string>();
    const out = new Set<string>();
    const cutoff = scanResult.currentCourseVisibleIndex;
    const now = new Date();
    for (const s of scanResult.sheets) {
      if (cutoff !== null && s.visibleOrderIndex > cutoff) continue;
      const skipped = new Set(skippedRowsBySheet[makeSheetKey(s)] ?? []);
      const trailingNoDateTeacherRows = trailingNoDateTeacherSessionRows(s.sampleRows);
      const maxValidationRowIndex =
        cutoff !== null && s.visibleOrderIndex === cutoff
          ? findLastTaughtSessionRowIndex(s.sampleRows, now)
          : null;
      for (let rIdx = 0; rIdx < s.sampleRows.length; rIdx++) {
        if (rowOutsideValidationScope(s.sampleRows, rIdx, skipped, trailingNoDateTeacherRows, maxValidationRowIndex, now)) {
          out.add(makeSheetKey(s));
          break;
        }
      }
    }
    return out;
  }, [isOpen, scanResult, mounted, skippedRowsBySheet]);

  const currentCourseVisibleIndex = scanResult?.currentCourseVisibleIndex ?? null;
  const importableSheets = useMemo(
    () =>
      (scanResult?.sheets ?? []).filter(
        (sheet) => currentCourseVisibleIndex === null || sheet.visibleOrderIndex <= currentCourseVisibleIndex
      ),
    [scanResult?.sheets, currentCourseVisibleIndex]
  );
  const isUpdatingExistingGroupCourses = useMemo(
    () => importableSheets.some((sheet) => Boolean(sheet.reimportDiff)),
    [importableSheets]
  );

  const hasImportBlockingSheetIssues = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return false;
    return sheetIssueCounts.some((c) => c > 0);
  }, [isOpen, scanResult, mounted, sheetIssueCounts]);

  /**
   * No structural updates left to apply on importable tabs: either never had reimport diff, or every
   * remaining new/changed session row is skipped. Session-row skips can clear the diff; attendance
   * cell skips alone can still warrant an import.
   */
  const hasNoEffectiveImportChanges = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return false;
    const cutoff = scanResult.currentCourseVisibleIndex;
    const importable = scanResult.sheets.filter((s) => cutoff === null || s.visibleOrderIndex <= cutoff);
    if (importable.length === 0) return true;
    return !importable.some((s) => {
      if (!s.reimportDiff) return true;
      const skipped = new Set(skippedRowsBySheet[makeSheetKey(s)] ?? []);
      return sheetHasRemainingStructuralDiff(s, skipped);
    });
  }, [isOpen, scanResult, mounted, skippedRowsBySheet]);

  const hasSkippedAttendanceCells = useMemo(
    () => Object.values(skippedAttendanceCellsBySheet).some((cells) => cells.length > 0),
    [skippedAttendanceCellsBySheet]
  );

  const resolvedWorkbookClassType: WorkbookClassType | null =
    scanResult?.workbookClassType ?? (manualWorkbookClassType === '' ? null : manualWorkbookClassType);

  /** Keep class-type picker visible whenever workbook title does not imply a class type. */
  const requiresManualWorkbookClassType = scanResult?.workbookClassType == null;

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

  const teacherMergeBlockedReason = useMemo(
    () => teacherMergeDecisionError(detectedNewTeachers, teacherMergeByKey),
    [detectedNewTeachers, teacherMergeByKey]
  );

  const confirmAllTeacherMergeBlockedReason = useMemo(() => {
    if (!onConfirmAllGroups || !batchScanResultsByGroup) return null;
    for (const [groupId, scan] of Object.entries(batchScanResultsByGroup)) {
      const slice = reviewSlicesByKey[groupId];
      const err = teacherMergeDecisionError(scan.detectedNewTeachers, slice?.teacherMergeByKey ?? EMPTY_TEACHER_MERGE);
      if (err) return err;
    }
    return null;
  }, [onConfirmAllGroups, batchScanResultsByGroup, reviewSlicesByKey]);

  const confirmImportBlocked =
    importRequiresResync ||
    hasImportBlockingSheetIssues ||
    resolvedWorkbookClassType === null ||
    (hasNoEffectiveImportChanges && !hasSkippedAttendanceCells) ||
    teacherMergeBlockedReason !== null;
  const busy = isImporting || isResyncing || isImportingAllGroups;
  const confirmAllBlocked =
    busy ||
    confirmImportBlocked ||
    isConfirmAllGroupsDisabled ||
    confirmAllTeacherMergeBlockedReason !== null;
  const emptyCellCount = sheetIssueCounts[activeTab] ?? 0;

  const existingTeachersForPicker = scanResult?.existingTeachersForPicker ?? [];
  const detectedNewStudents = useMemo(() => {
    const raw = scanResult?.detectedNewStudents ?? [];
    const byKey = new Map<string, string>();
    for (const name of raw) {
      const key = normalizePersonNameKey(name);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, name);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }, [scanResult?.detectedNewStudents]);
  const existingStudentsForPicker = scanResult?.existingStudentsForPicker ?? [];

  if (!isOpen || !scanResult || !mounted) return null;

  const sheets = scanResult.sheets;
  const activeSheet = sheets[activeTab];
  const activeIsFutureCourse =
    activeSheet != null &&
    currentCourseVisibleIndex !== null &&
    activeSheet.visibleOrderIndex > currentCourseVisibleIndex;

  const activeSkippedRows = activeSheet ? new Set(skippedRowsBySheet[makeSheetKey(activeSheet)] ?? []) : new Set<number>();
  const activeTrailingNoDateTeacherRows = activeSheet
    ? trailingNoDateTeacherSessionRows(activeSheet.sampleRows)
    : new Set<number>();
  const activeSkippedAttendanceCells = activeSheet
    ? new Set(skippedAttendanceCellsBySheet[makeSheetKey(activeSheet)] ?? [])
    : new Set<string>();
  const previewValidationNow = new Date();
  const activeMaxValidationRowIndex =
    activeSheet && currentCourseVisibleIndex !== null && activeSheet.visibleOrderIndex === currentCourseVisibleIndex
      ? findLastTaughtSessionRowIndex(activeSheet.sampleRows, previewValidationNow)
      : null;

  const toggleSkipRow = (sheet: ScannedSheet, rowIndex: number) => {
    const sheetKey = makeSheetKey(sheet);
    updateReviewSlice((slice) => {
      const prevRows = slice.skippedRowsBySheet;
      const before = new Set(prevRows[sheetKey] ?? []);
      if (before.has(rowIndex)) before.delete(rowIndex);
      else before.add(rowIndex);
      const nextRows: SkippedRowsBySheet = { ...prevRows };
      if (before.size === 0) delete nextRows[sheetKey];
      else nextRows[sheetKey] = [...before].sort((a, b) => a - b);

      const prevCells = slice.skippedAttendanceCellsBySheet;
      const cellBefore = new Set(prevCells[sheetKey] ?? []);
      const nextCellList = [...cellBefore].filter((token) => !token.startsWith(`${rowIndex}:`));
      const nextCells: SkippedAttendanceCellsBySheet = { ...prevCells };
      if (nextCellList.length === 0) delete nextCells[sheetKey];
      else nextCells[sheetKey] = nextCellList;

      return { ...slice, skippedRowsBySheet: nextRows, skippedAttendanceCellsBySheet: nextCells };
    });
    setOpenRowActionIndex(null);
  };

  const toggleSkipAttendanceCell = (sheet: ScannedSheet, rowIndex: number, studentName: string) => {
    const sheetKey = makeSheetKey(sheet);
    const token = `${rowIndex}:${studentName}`;
    updateReviewSlice((slice) => {
      const prevCells = slice.skippedAttendanceCellsBySheet;
      const before = new Set(prevCells[sheetKey] ?? []);
      if (before.has(token)) before.delete(token);
      else before.add(token);
      const nextCells: SkippedAttendanceCellsBySheet = { ...prevCells };
      if (before.size === 0) delete nextCells[sheetKey];
      else nextCells[sheetKey] = [...before].sort((a, b) => a.localeCompare(b));
      return { ...slice, skippedAttendanceCellsBySheet: nextCells };
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
          <div className="min-w-0">
            <h2 id="scan-preview-title" className="text-xl font-semibold text-gray-800 min-w-0 truncate">
              Review Import: {scanResult.workbookTitle}
            </h2>
            <div className="mt-1">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${
                  isUpdatingExistingGroupCourses
                    ? 'bg-sky-100 text-sky-950 ring-sky-300/80'
                    : 'bg-emerald-100 text-emerald-900 ring-emerald-300/80'
                }`}
              >
                {isUpdatingExistingGroupCourses ? 'Updating existing group & courses' : 'New sheet'}
              </span>
              {isUpdatingExistingGroupCourses ? (
                <p className="mt-2 max-w-xl text-xs text-slate-600 leading-relaxed">
                  Courses already marked completed in the database are auto-skipped on reimport: no diff checks for
                  those tabs and they are not written on import.
                </p>
              ) : null}
            </div>
          </div>
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
        {groupTabs.length > 0 ? (
          <div
            className="flex min-h-[3.25rem] items-end gap-1 border-b border-gray-200 bg-gray-100 px-6 pb-0 pt-2 overflow-x-auto no-scrollbar"
            role="tablist"
            aria-label="Groups to update"
          >
            {groupTabs.map((groupTab) => {
              const selected = groupTab.id === activeGroupTabId;
              const n = groupTab.detectedChangeCount;
              const tabAriaLabel =
                n != null
                  ? `${groupTab.label}, ${n} session rows with new or changed lesson data on scan`
                  : groupTab.label;
              return (
                <button
                  key={groupTab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={tabAriaLabel}
                  disabled={busy || groupTab.disabled}
                  onClick={() => onSelectGroupTab?.(groupTab.id)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-5 py-3 text-sm font-semibold whitespace-nowrap transition-colors ${
                    selected
                      ? 'relative z-[1] -mb-px border-gray-200 bg-white text-blue-700 shadow-[0_-1px_0_0_white]'
                      : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-200/60 hover:text-gray-900'
                  }`}
                >
                  <span>{groupTab.label}</span>
                  {n != null ? (
                    <span
                      className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-slate-200 px-1.5 py-0.5 text-[0.6875rem] font-bold leading-none text-slate-900 ring-1 ring-slate-400/35 tabular-nums"
                      title={groupTab.detectedChangeTooltip}
                    >
                      {n}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          className="flex min-h-[3.25rem] items-end gap-1 border-b border-gray-200 bg-gray-50 px-6 pb-0 pt-2 overflow-x-auto no-scrollbar"
          role="tablist"
          aria-label="Workbook sheets"
        >
          {sheets.map((sheet, idx) => {
            const tabIssues = sheetIssueCounts[idx] ?? 0;
            const hasSkippedRows = sheetHasSkippedSessionRows.has(makeSheetKey(sheet));
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
            const skippedForSheet = new Set(skippedRowsBySheet[makeSheetKey(sheet)] ?? []);
            const hasReimportUpdates = sheetHasRemainingStructuralDiff(sheet, skippedForSheet);
            const isUnchangedReimportTab = Boolean(sheet.reimportDiff) && !hasReimportUpdates;
            const analyzedCourseCompleted = Boolean(
              sheet.analyzedSyncCompleted
            );
            const isCourseCompleted = analyzedCourseCompleted && !hasSkippedRows;
            if (hasReimportUpdates) tabLabel = `${tabLabelBase}, updates since last import`;
            else if (isCourseCompleted) tabLabel = `${tabLabel}, completed`;
            return (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={activeTab === idx && !isFutureCourseTab}
                disabled={isResyncing || isFutureCourseTab}
                onClick={() =>
                  updateReviewSlice((slice) => ({
                    ...slice,
                    activeTab: idx,
                  }))
                }
                aria-label={tabLabel}
                title={
                  hasReimportUpdates
                      ? 'This tab matches an existing course; highlights show changes since the last import.'
                    : undefined
                }
                className={
                  isFutureCourseTab
                    ? 'shrink-0 rounded-t-lg border border-b-0 border-transparent bg-gray-100/80 px-5 py-3 text-sm font-semibold whitespace-nowrap text-gray-400 cursor-not-allowed inline-flex items-center gap-2'
                    : `shrink-0 rounded-t-lg border border-b-0 px-5 py-3 text-sm font-semibold whitespace-nowrap transition-colors inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        hasReimportUpdates && activeTab !== idx
                          ? 'border-sky-200/90 bg-sky-50/50'
                          : isUnchangedReimportTab && activeTab !== idx
                            ? 'border-gray-200/90 bg-gray-100/80 text-gray-500'
                          : ''
                      } ${
                        activeTab === idx
                          ? isUnchangedReimportTab
                            ? 'relative z-[1] -mb-px border-gray-200 bg-gray-100/90 text-gray-600 shadow-[0_-1px_0_0_white]'
                            : 'relative z-[1] -mb-px border-gray-200 bg-white text-blue-600 shadow-[0_-1px_0_0_white]'
                          : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-100/80 hover:text-gray-900'
                      }`
                }
              >
                {isCourseCompleted ? (
                  <span
                    className="size-2.5 shrink-0 rounded-full bg-emerald-500 ring-1 ring-emerald-300/80"
                    title="Course completed"
                    aria-hidden
                  />
                ) : null}
                <span className="truncate max-w-[min(40vw,20rem)]">{sheet.title}</span>
                {hasReimportUpdates ? (
                  <span
                    className="inline-flex shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-950 ring-1 ring-sky-300/80"
                    aria-hidden
                  >
                    <span className="material-symbols-outlined text-sm leading-none">difference</span>
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
              <div className="mt-3">
                <select
                  id="manual-workbook-class-type"
                  value={manualWorkbookClassType}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateReviewSlice((slice) => ({
                      ...slice,
                      manualWorkbookClassType: v === '' ? '' : (v as WorkbookClassType),
                    }));
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
                These spellings are not matched yet (canonical name or saved alias). For each name, choose an existing
                teacher to save it as an alias for future imports, or explicitly choose &quot;Create new teacher&quot;.
                Import stays disabled until every row has a choice.
              </p>
              <ul className="mt-3 space-y-2" aria-label="Map new teacher names">
                {detectedNewTeachers.map((teacherName) => {
                  const nk = normalizePersonNameKey(teacherName);
                  const mergedId = teacherMergeByKey[nk];
                  const selectValue =
                    mergedId === undefined || mergedId === '' ? '' : mergedId;
                  const mergedLabel =
                    mergedId && mergedId !== REVIEW_TEACHER_MERGE_CREATE_NEW
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
                        value={selectValue}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateReviewSlice((slice) => {
                            const next = { ...slice.teacherMergeByKey };
                            if (!v) delete next[nk];
                            else next[nk] = v;
                            return { ...slice, teacherMergeByKey: next };
                          });
                        }}
                        disabled={busy}
                        className="min-w-[12rem] max-w-[min(100%,20rem)] rounded border border-emerald-300/80 bg-white px-2 py-1 text-xs font-medium text-gray-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-50"
                        aria-label={`Link sheet name ${teacherName} to existing teacher`}
                      >
                        <option value="">Choose…</option>
                        <option value={REVIEW_TEACHER_MERGE_CREATE_NEW}>Create new teacher</option>
                        {existingTeachersForPicker.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      {mergedId === REVIEW_TEACHER_MERGE_CREATE_NEW ? (
                        <span className="text-xs text-emerald-800">A new teacher row will be created on import.</span>
                      ) : null}
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
          {detectedNewStudents.length > 0 ? (
            <section className="mb-4 rounded-md border border-blue-200 bg-blue-50/70 px-4 py-3">
              <h3 className="text-sm font-semibold text-blue-900">New student names</h3>
              <p className="mt-1 text-xs text-blue-800">
                These spellings are not matched yet for this group (canonical name or saved alias). Choose an
                existing student to treat a name as an alias—it is stored and used on future imports. Otherwise a new
                student is created.
              </p>
              <ul className="mt-3 space-y-2" aria-label="Map new student names">
                {detectedNewStudents.map((studentName) => {
                  const nk = normalizePersonNameKey(studentName);
                  const mergedId = studentMergeByKey[nk];
                  const mergedLabel = mergedId
                    ? existingStudentsForPicker.find((s) => s.id === mergedId)?.name
                    : undefined;
                  return (
                    <li
                      key={nk}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200/80 bg-white/90 px-3 py-2 text-sm text-blue-950"
                    >
                      <span className="min-w-[6rem] font-medium">{studentName}</span>
                      <span className="text-xs text-blue-800">→</span>
                      <select
                        value={mergedId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateReviewSlice((slice) => {
                            const next = { ...slice.studentMergeByKey };
                            if (!v) delete next[nk];
                            else next[nk] = v;
                            return { ...slice, studentMergeByKey: next };
                          });
                        }}
                        disabled={busy}
                        className="min-w-[12rem] max-w-[min(100%,20rem)] rounded border border-blue-300/80 bg-white px-2 py-1 text-xs font-medium text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
                        aria-label={`Link sheet name ${studentName} to existing student`}
                      >
                        <option value="">Create new student</option>
                        {existingStudentsForPicker.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                      {mergedLabel ? (
                        <span className="text-xs text-blue-800">
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
          {hasNoEffectiveImportChanges && !isImporting && !isResyncing ? (
            <section className="mb-4 rounded-md border border-sky-300 bg-sky-50/90 px-4 py-3" role="status" aria-live="polite">
              <h3 className="text-sm font-semibold text-sky-950">No updates detected</h3>
              <p className="mt-1 text-xs text-sky-900">
                {hasSkippedAttendanceCells
                  ? 'No lesson rows or core fields differ from the database for importable tabs. You can still import to apply attendance cell skips.'
                  : 'This import matches what is already in the database for the importable tabs (including skipped rows). There is nothing new to apply, so import is disabled.'}
              </p>
            </section>
          ) : null}
          {importRequiresResync && !isImporting && !isResyncing ? (
            <section
              className="mb-4 rounded-md border border-slate-300 bg-slate-50/90 px-4 py-3"
              role="status"
              aria-live="polite"
            >
              <h3 className="text-sm font-semibold text-slate-900">Import completed</h3>
              <p className="mt-1 text-xs text-slate-700">
                Confirm &amp; Import is disabled after a completed import. Use <strong>Resync</strong> to fetch the
                latest sheet state before importing again.
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
              {importMutationDbLog.length > 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50/95">
                  <div className="border-b border-slate-200 bg-slate-100/80 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Database activity
                  </div>
                  <div
                    ref={importLogScrollRef}
                    className="max-h-[min(40vh,16rem)] overflow-y-auto px-3 py-2"
                    aria-label="Database write steps"
                  >
                    <ol className="font-mono text-[0.7rem] leading-relaxed text-slate-800 space-y-0.5 list-decimal list-inside marker:text-slate-400">
                      {importMutationDbLog.map((line, idx) => (
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
          {importApplySummary ? (
            <section className="mb-4 rounded-md border border-emerald-200 bg-emerald-50/80 px-4 py-3">
              <h3 className="text-sm font-semibold text-emerald-900">Applied session summary</h3>
              <p className="mt-1 text-xs text-emerald-800">
                Added {importApplySummary.totals.sessionsInserted}, changed {importApplySummary.totals.sessionsUpdated}, removed{' '}
                {importApplySummary.totals.sessionsDeleted}, skipped {importApplySummary.totals.skippedSessionRows} session
                row(s).
              </p>
            </section>
          ) : null}
          {activeSheet && activeIsFutureCourse ? (
            <div
              className="rounded-md border border-gray-200 bg-gray-50 px-6 py-10 text-center text-sm text-gray-500"
              role="status"
            >
              This course comes after the current course in the workbook. It is not validated here and is not
              included in import.
            </div>
          ) : activeSheet ? (() => {
            const tableDatumChronoScope = sampleRowsDatumChronologyScope(
              activeSheet.sampleRows,
              activeSkippedRows,
              activeTrailingNoDateTeacherRows,
              activeMaxValidationRowIndex,
              previewValidationNow
            );
            return (
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
                      const rowIsTrailingNoDateTeacher = activeTrailingNoDateTeacherRows.has(rIdx);
                      const rowIsFutureSession = isSheetDatumStrictlyAfterToday(
                        row.values['Datum'] ?? '',
                        previewValidationNow
                      );
                      const rowIsAutoSkipped = rowIsSkipped || rowIsTrailingNoDateTeacher || rowIsFutureSession;
                      const rowOutsideValidation = rowOutsideValidationScope(
                        rows,
                        rIdx,
                        activeSkippedRows,
                        activeTrailingNoDateTeacherRows,
                        activeMaxValidationRowIndex,
                        previewValidationNow
                      );
                      const chronoRowAllowed = !rowOutsideChronologyValidationTarget(tableDatumChronoScope, rIdx);
                      const datumChrono =
                        chronoRowAllowed && isDatumChronologyOutlier(tableDatumChronoScope, rIdx);
                      const datumEmpty = isEmptyCellValue(row.values['Datum']);
                      const datumInvalid = !datumEmpty && parseSheetDatum(row.values['Datum'] ?? '') === null;
                      const isNewReimportSession = Boolean(
                        activeSheet.reimportDiff?.newSessionRowIndices.includes(rIdx)
                      );
                      const changedCells = activeSheet.reimportDiff?.changedCellsByRow[rIdx] ?? [];
                      const hasRowReimportDiff = isNewReimportSession || changedCells.length > 0;
                      const isUnchangedReimportRow =
                        !rowIsAutoSkipped && Boolean(activeSheet.reimportDiff) && !hasRowReimportDiff;
                      const rowDiffText = rowDiffSummary(activeSheet, rIdx);
                      const warnFolien =
                        !rowIsAutoSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Folien') &&
                        isEmptyCellValue(row.values['Folien']);
                      const warnDatumEmpty =
                        !rowIsAutoSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Datum') &&
                        datumEmpty;
                      const warnDatumChrono =
                        !rowIsAutoSkipped &&
                        chronoRowAllowed &&
                        datumChronoInReimportScope(activeSheet, rIdx) &&
                        !datumEmpty &&
                        !datumInvalid &&
                        datumChrono;
                      const warnDatumInvalid =
                        !rowIsAutoSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Datum') &&
                        datumInvalid;
                      const warnDatum = warnDatumEmpty || warnDatumInvalid || warnDatumChrono;
                      const warnVon =
                        !rowIsAutoSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'von') &&
                        isEmptyCellValue(row.values['von']);
                      const warnBis =
                        !rowIsAutoSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'bis') &&
                        isEmptyCellValue(row.values['bis']);
                      const warnLehrer =
                        !rowIsAutoSkipped &&
                        !rowOutsideValidation &&
                        validationInReimportScope(activeSheet, rIdx, 'Lehrer') &&
                        isEmptyCellValue(row.values['Lehrer']) &&
                        isSheetDatumOnOrBeforeToday(row.values['Datum'] ?? '', previewValidationNow);
                      return (
                      <tr
                        key={rIdx}
                        className={`hover:bg-gray-50 ${
                          rowIsAutoSkipped ? 'bg-gray-50/70 text-gray-400' : ''
                        } ${
                          !rowIsAutoSkipped && hasRowReimportDiff && activeSheet.reimportDiff
                            ? 'bg-sky-50/70'
                            : isUnchangedReimportRow
                              ? 'bg-gray-50/80 text-gray-400'
                            : ''
                        }`}
                      >
                        <td
                          className={`px-3 py-2 border-r border-gray-200 relative ${
                            !rowIsAutoSkipped && hasRowReimportDiff && activeSheet.reimportDiff
                              ? 'border-l-4 border-l-sky-500 bg-sky-50/60'
                              : ''
                          }`}
                        >
                          {!rowIsAutoSkipped && rowDiffText ? (
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
                                : isUnchangedReimportRow
                                  ? 'bg-gray-50/80 text-gray-400'
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
                                : isUnchangedReimportRow
                                  ? 'bg-gray-50/80 text-gray-400'
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
                                : isUnchangedReimportRow
                                  ? 'bg-gray-50/80 text-gray-400'
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
                                : isUnchangedReimportRow
                                  ? 'bg-gray-50/80 text-gray-400'
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
                                : isUnchangedReimportRow
                                  ? 'bg-gray-50/80 text-gray-400'
                                : ''
                          }`}
                          {...hintHandlers(
                            warnLehrer
                              ? HINT_LEHRER_PAST_OR_TODAY
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
                              activeTrailingNoDateTeacherRows,
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
                            : isUnchangedReimportRow
                              ? 'bg-gray-50/80 text-gray-400 border-r border-gray-200'
                            : updateCell
                              ? CELL_UPDATE_CLASS
                              : studentAttendanceCellClass(cellText, row.studentAttendance[student.name]);
                          const canToggleCellSkip = !rowIsAutoSkipped && (isCellSkipped || warnEmpty);
                          return (
                            <td
                              key={cIdx}
                              className={`px-4 py-2 ${rowIsAutoSkipped ? 'border-r border-gray-200' : tone} ${canToggleCellSkip ? 'cursor-pointer select-none' : ''}`}
                              onClick={() => {
                                if (busy || !canToggleCellSkip) return;
                                toggleSkipAttendanceCell(activeSheet, rIdx, student.name);
                              }}
                              {...hintHandlers(
                                !rowIsAutoSkipped && isCellSkipped
                                  ? `This attendance cell will be skipped for ${student.name} in this session. Click to include it again.`
                                  : !rowIsAutoSkipped && warnEmpty
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
            );
          })() : (
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
          {onConfirmAllGroups ? (
            <button
              type="button"
              onClick={() => {
                const { teacherAliasResolutions, newTeacherCreateAcknowledgements } =
                  buildTeacherImportReviewPayload(detectedNewTeachers, teacherMergeByKey);
                const studentAliasResolutions: StudentAliasResolution[] = [];
                for (const name of detectedNewStudents) {
                  const sid = studentMergeByKey[normalizePersonNameKey(name)];
                  if (sid) studentAliasResolutions.push({ aliasName: name, studentId: sid });
                }
                const workbookClassTypeForApi =
                  scanResult.workbookClassType == null ? resolvedWorkbookClassType ?? undefined : undefined;
                onConfirmAllGroups(
                  skippedRowsBySheet,
                  skippedAttendanceCellsBySheet,
                  teacherAliasResolutions,
                  studentAliasResolutions,
                  newTeacherCreateAcknowledgements,
                  workbookClassTypeForApi,
                  reviewSlicesByKey
                );
              }}
              disabled={confirmAllBlocked}
              title={
                !busy && confirmAllTeacherMergeBlockedReason ? confirmAllTeacherMergeBlockedReason : undefined
              }
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2 shadow-sm"
            >
              {isImportingAllGroups ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                  Updating all groups...
                </>
              ) : (
                'Update all groups'
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const { teacherAliasResolutions, newTeacherCreateAcknowledgements } =
                buildTeacherImportReviewPayload(detectedNewTeachers, teacherMergeByKey);
              const studentAliasResolutions: StudentAliasResolution[] = [];
              for (const name of detectedNewStudents) {
                const sid = studentMergeByKey[normalizePersonNameKey(name)];
                if (sid) studentAliasResolutions.push({ aliasName: name, studentId: sid });
              }
              const workbookClassTypeForApi =
                scanResult.workbookClassType == null ? resolvedWorkbookClassType ?? undefined : undefined;
              onConfirm(
                skippedRowsBySheet,
                skippedAttendanceCellsBySheet,
                teacherAliasResolutions,
                studentAliasResolutions,
                newTeacherCreateAcknowledgements,
                workbookClassTypeForApi
              );
            }}
            disabled={busy || confirmImportBlocked}
            title={
              !busy && resolvedWorkbookClassType === null
                ? 'Select a class type (or fix the workbook title and resync).'
                : !busy && teacherMergeBlockedReason
                  ? teacherMergeBlockedReason
                : !busy && importRequiresResync
                  ? 'Import completed. Resync first before importing again.'
                : !busy && hasNoEffectiveImportChanges && !hasSkippedAttendanceCells
                  ? 'Nothing left to import for importable tabs. Edit the sheet and resync, or undo row skips if you still need those updates.'
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
