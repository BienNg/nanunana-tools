import { parseSpreadsheetIdFromUrl } from '@/lib/googleSheets/parseSpreadsheetIdFromUrl';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { isIsoDateStrictlyAfterLocalToday, isSheetDatumStrictlyAfterToday } from '@/lib/sync/currentCourseSheet';
import type {
  ScanGoogleSheetResult,
  ScannedSampleRow,
  ScannedSheet,
  ScannedSheetReimportDiff,
  SyncProgressEvent,
} from '@/lib/sync/googleSheetSync';

type SessionDateSkipReason = 'future' | null;

export type ExistingCourseRow = {
  id: string;
  name: string;
  sheet_url: string | null;
  sync_completed?: boolean | null;
};

export type ScannedImportSessionAnalysis = {
  eligibleRowIndices: number[];
  autoSkippedFutureRows: number;
  autoSkippedInvalidDateRows: number;
  autoSkippedTotal: number;
  openSessionRows: number;
};

export type LessonCompareSnapshot = {
  slide_id: string | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  teacher: string | null;
};

function parseTeacherNames(raw: string | undefined | null): string[] {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (!s) return [];
  return s
    .split(/[/,;\n]+|\s+und\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeTimeForDb(value: string | undefined | null): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length === 2) return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:00`;
  if (parts.length === 3) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
  }
  return null;
}

function parseSheetDate(raw: string | undefined | null): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/').map((p) => p.trim());
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [d, m, y] = s.split('.').map((p) => p.trim());
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dmy = s.match(/(^|[^\d])(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?=$|[^\d])/);
  if (dmy) {
    const d = dmy[2] ?? '';
    const m = dmy[3] ?? '';
    const yy = dmy[4] ?? '';
    let y = yy;
    if (yy.length === 2) {
      const n = Number(yy);
      if (Number.isFinite(n)) y = String(n >= 70 ? 1900 + n : 2000 + n);
    }
    if (y.length === 4) {
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  return null;
}

function normalizeFolienKey(value: string | undefined | null): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function classifySessionDateSkip(
  parsedDate: string | null,
  datumRaw: string | undefined | null,
  hasDatumColumn: boolean,
  now: Date
): SessionDateSkipReason {
  void hasDatumColumn;
  if (isSheetDatumStrictlyAfterToday(datumRaw, now)) return 'future';
  if (parsedDate && isIsoDateStrictlyAfterLocalToday(parsedDate, now)) return 'future';
  return null;
}

function parseGidFromGoogleSheetUrl(url: string): string | null {
  const m = url.match(/[#&]gid=(\d+)/i);
  return m?.[1] ?? null;
}

/** Same spreadsheet tab for course matching during scan (legacy rows may omit `sheet_url`). */
export function courseDbUrlMatchesTabUrl(dbUrl: string | null | undefined, tabUrl: string | null): boolean {
  const d = (dbUrl ?? '').trim();
  const t = (tabUrl ?? '').trim();
  if (!d && !t) return true;
  if (!d && t) return true;
  if (d && !t) return false;
  const idD = parseSpreadsheetIdFromUrl(d);
  const idT = parseSpreadsheetIdFromUrl(t);
  if (idD && idT && idD === idT) {
    const gD = parseGidFromGoogleSheetUrl(d);
    const gT = parseGidFromGoogleSheetUrl(t);
    if (gD && gT) return gD === gT;
    if (!gD && !gT) return true;
    return false;
  }
  return d === t;
}

/**
 * Match scan tab to existing DB course similarly to sync import resolution:
 * prefer exact tab URL when possible, but fall back to same-name rows so
 * completion mismatches are still surfaced for legacy/missing sheet_url data.
 */
export function findExistingCourseForScannedTab(
  courses: ExistingCourseRow[],
  sheetTitle: string,
  sheetUrl: string | null
): ExistingCourseRow | null {
  const sameName = courses.filter((c) => c.name === sheetTitle);
  if (sameName.length === 0) return null;
  if (sameName.length === 1) return sameName[0] ?? null;
  if (sheetUrl) {
    const byUrl = sameName.find((c) => courseDbUrlMatchesTabUrl(c.sheet_url, sheetUrl));
    if (byUrl) return byUrl;
  }
  const withoutStoredUrl = sameName.find((c) => !(c.sheet_url ?? '').trim());
  if (withoutStoredUrl) return withoutStoredUrl;
  return sameName[0] ?? null;
}

export function normalizeTeacherCellForCompare(raw: string | undefined | null): string {
  const parts = parseTeacherNames(raw)
    .map((p) => normalizePersonNameKey(p))
    .filter(Boolean)
    .sort();
  return parts.join('|');
}

export function dbTimeToComparable(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const m = String(value).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return normalizeTimeForDb(value);
  const hh = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const ss = (m[3] ?? '00').padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function sheetStudentStatusForCompare(row: ScannedSampleRow, studentName: string): 'Present' | 'Absent' | null {
  const a = row.studentAttendance[studentName];
  if (a === 'Present' || a === 'Absent') return a;
  const t = String(row.values[studentName] ?? '').trim();
  if (/\babwesend\b/i.test(t) || /\babsent\b/i.test(t)) return 'Absent';
  return null;
}

function reimportHintDisplayCell(s: string | undefined | null): string {
  const t = String(s ?? '').trim();
  return t.length > 0 ? t : '(empty)';
}

function reimportHintIsoDateDe(iso: string | null): string {
  if (!iso) return '(empty)';
  const head = String(iso).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (!m) return head;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function reimportHintSheetDatum(raw: string | undefined): string {
  const parsed = parseSheetDate(raw ?? '');
  if (parsed) return reimportHintIsoDateDe(parsed);
  return reimportHintDisplayCell(raw);
}

function reimportHintTimeCompare(comparable: string | null): string {
  if (!comparable) return '(empty)';
  const m = comparable.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (m) return `${m[1]}:${m[2]}`;
  return comparable;
}

function reimportRowExactlyMatchesLesson(
  row: ScannedSampleRow,
  lesson: LessonCompareSnapshot
): boolean {
  if (normalizeFolienKey(row.values['Folien']) !== normalizeFolienKey(lesson.slide_id)) return false;

  const sheetDate = parseSheetDate(row.values['Datum'] ?? '');
  if ((sheetDate ?? null) !== (lesson.date ?? null)) return false;

  const sStart = normalizeTimeForDb(row.values['von'] ?? null);
  const sEnd = normalizeTimeForDb(row.values['bis'] ?? null);
  if (
    (sStart ?? null) !== (dbTimeToComparable(lesson.start_time) ?? null) ||
    (sEnd ?? null) !== (dbTimeToComparable(lesson.end_time) ?? null)
  ) {
    return false;
  }

  const tSheet = normalizeTeacherCellForCompare(row.values['Lehrer']);
  const tDb = normalizeTeacherCellForCompare(lesson.teacher);
  if (tSheet !== tDb) return false;

  return true;
}

function trailingNoDateTeacherRowIndices(
  rows: ReadonlyArray<{ values: Record<string, string> }>
): ReadonlySet<number> {
  const out = new Set<number>();
  let allFollowingNoDateTeacher = true;
  for (let rIdx = rows.length - 1; rIdx >= 0; rIdx--) {
    const row = rows[rIdx];
    const hasDate = String(row.values['Datum'] ?? '').trim().length > 0;
    const hasTeacher = String(row.values['Lehrer'] ?? '').trim().length > 0;
    const noDateTeacher = !hasDate && !hasTeacher;
    if (allFollowingNoDateTeacher && noDateTeacher) {
      out.add(rIdx);
    } else {
      allFollowingNoDateTeacher = false;
    }
  }
  return out;
}

/**
 * Shared scan/import classification for session-like rows in scanned sampleRows.
 * `rIdx === previewRowIndex` for each row in sampleRows.
 */
export function analyzeScannedSheetSessionsForImport(sheet: ScannedSheet, now: Date): ScannedImportSessionAnalysis {
  const hasDatumColumn = Boolean(sheet.headers.datum);
  const autoSkippedNoDateTeacherRows = trailingNoDateTeacherRowIndices(sheet.sampleRows);
  const eligibleRowIndices: number[] = [];
  let autoSkippedFutureRows = 0;
  const autoSkippedInvalidDateRows = 0;
  let openSessionRows = 0;
  for (let rIdx = 0; rIdx < sheet.sampleRows.length; rIdx++) {
    const row = sheet.sampleRows[rIdx];
    if (autoSkippedNoDateTeacherRows.has(rIdx)) {
      continue;
    }
    const datumRaw = row.values['Datum'] ?? '';
    const parsedDate = parseSheetDate(datumRaw);
    const reason = classifySessionDateSkip(parsedDate, datumRaw, hasDatumColumn, now);
    if (reason === 'future') {
      autoSkippedFutureRows += 1;
      continue;
    }
    eligibleRowIndices.push(rIdx);
    const teacher = String(row.values['Lehrer'] ?? '').trim();
    if (!parsedDate || !teacher) openSessionRows += 1;
  }
  return {
    eligibleRowIndices,
    autoSkippedFutureRows,
    autoSkippedInvalidDateRows,
    autoSkippedTotal: autoSkippedFutureRows + autoSkippedInvalidDateRows,
    openSessionRows,
  };
}

export async function loadLessonSnapshotsMapForCourses(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  courseIds: string[],
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<Map<string, LessonCompareSnapshot[]>> {
  const out = new Map<string, LessonCompareSnapshot[]>();
  for (const id of courseIds) out.set(id, []);
  if (courseIds.length === 0) return out;

  await onProgress?.({ type: 'db', message: 'reimport diff — batch load lessons' });
  const { data: lessons, error: leErr } = await supabase
    .from('lessons')
    .select('id, course_id, slide_id, date, start_time, end_time, teacher')
    .in('course_id', courseIds);
  if (leErr) throw new Error(leErr.message);
  if (!lessons?.length) return out;

  lessons.sort((a, b) => {
    const ca = String(a.course_id);
    const cb = String(b.course_id);
    if (ca !== cb) return ca.localeCompare(cb);
    const da = a.date as string | null | undefined;
    const db = b.date as string | null | undefined;
    if (!da && !db) {
    } else if (!da) return 1;
    else if (!db) return -1;
    else if (da !== db) return String(da).localeCompare(String(db));

    const ta = a.start_time != null ? String(a.start_time) : '';
    const tb = b.start_time != null ? String(b.start_time) : '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.id).localeCompare(String(b.id));
  });

  for (const L of lessons) {
    const cid = L.course_id as string;
    const arr = out.get(cid);
    if (!arr) continue;
    arr.push({
      slide_id: L.slide_id != null ? String(L.slide_id) : null,
      date: L.date != null ? String(L.date).slice(0, 10) : null,
      start_time: L.start_time != null ? String(L.start_time) : null,
      end_time: L.end_time != null ? String(L.end_time) : null,
      teacher: L.teacher != null ? String(L.teacher) : null,
    });
  }
  return out;
}

export function buildReimportDiffForSheet(
  sheet: ScannedSheet,
  courseId: string,
  dbLessons: LessonCompareSnapshot[],
  now: Date
): ScannedSheetReimportDiff {
  const analysis = analyzeScannedSheetSessionsForImport(sheet, now);
  const eligible = analysis.eligibleRowIndices;
  const changedCellsByRow: Record<number, string[]> = {};
  const changeHintsByRow: Record<number, Record<string, string>> = {};
  const newSessionRowIndices: number[] = [];

  const pairedDbIndexByRow = new Map<number, number>();
  const remainingDbIndices = new Set<number>(dbLessons.map((_, idx) => idx));
  for (const rIdx of eligible) {
    const row = sheet.sampleRows[rIdx];
    let hit: number | null = null;
    for (const dbIdx of remainingDbIndices) {
      const lesson = dbLessons[dbIdx];
      if (lesson && reimportRowExactlyMatchesLesson(row, lesson)) {
        hit = dbIdx;
        break;
      }
    }
    if (hit !== null) {
      pairedDbIndexByRow.set(rIdx, hit);
      remainingDbIndices.delete(hit);
    }
  }
  for (const rIdx of eligible) {
    if (pairedDbIndexByRow.has(rIdx)) continue;
    const row = sheet.sampleRows[rIdx];
    const folienKey = normalizeFolienKey(row.values['Folien']);
    if (!folienKey) continue;
    const candidates: number[] = [];
    for (const dbIdx of remainingDbIndices) {
      const lesson = dbLessons[dbIdx];
      if (!lesson) continue;
      if (normalizeFolienKey(lesson.slide_id) === folienKey) {
        candidates.push(dbIdx);
      }
    }
    if (candidates.length === 1) {
      const dbIdx = candidates[0]!;
      pairedDbIndexByRow.set(rIdx, dbIdx);
      remainingDbIndices.delete(dbIdx);
    }
  }
  const fallbackDbIndices = [...remainingDbIndices].sort((a, b) => a - b);
  let fallbackCursor = 0;
  for (const rIdx of eligible) {
    if (pairedDbIndexByRow.has(rIdx)) continue;
    const dbIdx = fallbackDbIndices[fallbackCursor];
    if (dbIdx == null) continue;
    pairedDbIndexByRow.set(rIdx, dbIdx);
    fallbackCursor += 1;
  }

  for (const rIdx of eligible) {
    const row = sheet.sampleRows[rIdx];
    const dbIdx = pairedDbIndexByRow.get(rIdx);
    const lesson = dbIdx == null ? undefined : dbLessons[dbIdx];
    if (!lesson) {
      newSessionRowIndices.push(rIdx);
      continue;
    }

    const changed: string[] = [];
    const hints: Record<string, string> = {};
    const track = (key: string, hint: string) => {
      changed.push(key);
      hints[key] = hint;
    };

    if (normalizeFolienKey(row.values['Folien']) !== normalizeFolienKey(lesson.slide_id)) {
      track(
        'Folien',
        `Folien / slides: was "${reimportHintDisplayCell(lesson.slide_id)}" — sheet now "${reimportHintDisplayCell(row.values['Folien'])}".`
      );
    }

    const sheetDate = parseSheetDate(row.values['Datum'] ?? '');
    const dbD = lesson.date;
    if ((sheetDate ?? null) !== (dbD ?? null)) {
      track(
        'Datum',
        `Date: was ${reimportHintIsoDateDe(dbD)} — sheet now ${reimportHintSheetDatum(row.values['Datum'])}.`
      );
    }

    const sStart = normalizeTimeForDb(row.values['von'] ?? null);
    const sEnd = normalizeTimeForDb(row.values['bis'] ?? null);
    if ((sStart ?? null) !== (dbTimeToComparable(lesson.start_time) ?? null)) {
      track(
        'von',
        `Start (von): was ${reimportHintTimeCompare(dbTimeToComparable(lesson.start_time))} — sheet now ${reimportHintTimeCompare(sStart)}.`
      );
    }
    if ((sEnd ?? null) !== (dbTimeToComparable(lesson.end_time) ?? null)) {
      track(
        'bis',
        `End (bis): was ${reimportHintTimeCompare(dbTimeToComparable(lesson.end_time))} — sheet now ${reimportHintTimeCompare(sEnd)}.`
      );
    }

    const tSheet = normalizeTeacherCellForCompare(row.values['Lehrer']);
    const tDb = normalizeTeacherCellForCompare(lesson.teacher);
    if (tSheet !== tDb) {
      track(
        'Lehrer',
        `Teacher: was "${reimportHintDisplayCell(lesson.teacher)}" — sheet now "${reimportHintDisplayCell(row.values['Lehrer'])}".`
      );
    }

    if (changed.length > 0) {
      changedCellsByRow[rIdx] = changed;
      changeHintsByRow[rIdx] = hints;
    }
  }

  const hasStructuralChanges =
    newSessionRowIndices.length > 0 || Object.keys(changedCellsByRow).length > 0;

  return {
    courseId,
    changedCellsByRow,
    changeHintsByRow,
    newSessionRowIndices,
    hasStructuralChanges,
  };
}

/** Shown on bulk group tabs for the structural change badge. */
export const DETECTED_STRUCTURAL_CHANGES_TOOLTIP =
  'Session rows with new lessons or changed core fields (Folien, date, times, teacher) detected on scan—importable tabs only. Attendance-only edits are not counted.';

/**
 * Session rows that scan treats as new or structurally changed (importable tabs only).
 * Existing tabs: {@link ScannedSheetReimportDiff} new rows plus rows with any changed core column.
 * Tabs without a DB course match: {@link analyzeScannedSheetSessionsForImport} eligible rows.
 */
export function countDetectedStructuralWorkForReviewScan(
  scan: Extract<ScanGoogleSheetResult, { success: true }>,
  now: Date = new Date()
): number {
  const cutoff = scan.currentCourseVisibleIndex;
  let total = 0;
  for (const sheet of scan.sheets) {
    if (cutoff !== null && sheet.visibleOrderIndex > cutoff) continue;
    const d = sheet.reimportDiff;
    if (d) {
      total += d.newSessionRowIndices.length;
      total += Object.keys(d.changedCellsByRow).length;
    } else {
      const { eligibleRowIndices } = analyzeScannedSheetSessionsForImport(sheet, now);
      total += eligibleRowIndices.length;
    }
  }
  return total;
}

export function collectTeacherNamesFromScannedSheets(sheets: ScannedSheet[]): string[] {
  const namesByKey = new Map<string, string>();
  for (const sheet of sheets) {
    for (const row of sheet.sampleRows) {
      for (const teacherName of parseTeacherNames(row.values['Lehrer'])) {
        const key = normalizePersonNameKey(teacherName);
        if (!key || namesByKey.has(key)) continue;
        namesByKey.set(key, teacherName);
      }
    }
  }
  return [...namesByKey.values()].sort((a, b) => a.localeCompare(b));
}
