import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { findCurrentCourseVisibleIndex, isIsoDateStrictlyAfterLocalToday } from '@/lib/sync/currentCourseSheet';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import type { GroupClassType } from '@/lib/courseDuration';
import { parseWorkbookClassTypeInput } from '@/lib/courseDuration';
import { loadWorkbookFromSource } from '@/lib/sync/googleSheetWorkbookSource';
import {
  columnIndexToA1Letter,
  dedupeSheetStudentColumns,
  findCoreColumnIndices,
  findHeaderRowIndex,
  isNonStudentColumnHeader,
  lehrerColumnIndices,
  mergedFeedbackFromRow,
  normalizeFolienKey,
  pickFirstAttendanceStatus,
  processVisibleSheetGrid,
} from '@/lib/sync/googleSheetGridParser';
import {
  analyzeScannedSheetSessionsForImport,
  buildReimportDiffForSheet,
  collectTeacherNamesFromScannedSheets,
  courseDbUrlMatchesTabUrl,
  dbTimeToComparable,
  findExistingCourseForScannedTab,
  loadLessonSnapshotsMapForCourses,
  normalizeTeacherCellForCompare,
} from '@/lib/sync/googleSheetReimportDiff';
import type { AttendanceFromColor, SheetRow, SheetSyncSource } from '@/lib/sync/googleSheetWorkbookSource';
import type { ExistingCourseRow } from '@/lib/sync/googleSheetReimportDiff';
import type { ScannedSampleRow, ScannedStudent } from '@/lib/sync/googleSheetGridParser';
import {
  applyTeacherAliasResolutions,
  loadTeacherResolutionData,
  parseTeacherAliasResolutions,
  syncCourseTeachers,
} from '@/lib/sync/googleSheetTeacherSync';
import { syncOneScannedCourseSheet } from '@/lib/sync/googleSheetScannedCourseSync';
import type { TeacherAliasResolution } from '@/lib/sync/googleSheetTeacherSync';

const LESSON_SYNC_CONCURRENCY = 4;

async function runWithConcurrencyLimit(
  total: number,
  limit: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  if (total <= 0) return;
  const safeLimit = Math.max(1, Math.min(limit, total));
  let nextIndex = 0;

  const runOne = async () => {
    for (;;) {
      const idx = nextIndex;
      if (idx >= total) return;
      nextIndex += 1;
      await worker(idx);
    }
  };

  const workers = Array.from({ length: safeLimit }, () => runOne());
  await Promise.all(workers);
}

/** PostgREST when the column was never migrated / not in schema cache yet. */
function isSupabaseMissingColumnError(message: string | undefined, column: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const col = column.toLowerCase();
  return m.includes(col) && (m.includes('schema cache') || m.includes('could not find'));
}

/** Split one or more teacher names from a cell (comma, slash, semicolon, newline, German "und"). */
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
  /**
   * Tolerant fallback for sheet cells like:
   * - "16.12.2025 00:00:00"
   * - "16.12.25"
   * - "Di, 16.12.2025"
   */
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

type SessionDateSkipReason = 'future' | null;

function classifySessionDateSkip(
  parsedDate: string | null,
  hasDatumColumn: boolean,
  now: Date
): SessionDateSkipReason {
  void hasDatumColumn;
  if (parsedDate && isIsoDateStrictlyAfterLocalToday(parsedDate, now)) return 'future';
  return null;
}

function isCourseSyncCompleted(
  autoSkippedFutureRows: number,
  autoSkippedInvalidDateRows: number,
  eligibleSessionRows: number,
  openSessionRows: number,
  skippedSessionRows = 0
): boolean {
  // Completion is based only on future session skips.
  // If at least one future session row is auto-skipped, the course is not completed.
  // If no sessions are imported, the course is also not completed.
  // If any session row is skipped (for example, user-skipped in Review Import), the course is not completed.
  void autoSkippedInvalidDateRows;
  void openSessionRows;
  return autoSkippedFutureRows === 0 && eligibleSessionRows > 0 && skippedSessionRows === 0;
}

function isGroupSyncCompleted(
  skippedAfterCurrentCourse: number,
  allImportedCoursesCompleted: boolean
): boolean {
  return skippedAfterCurrentCourse === 0 && allImportedCoursesCompleted;
}

function analyzeRawSheetSessionSkips(
  rows: SheetRow[] | undefined,
  options?: {
    dedupeFolienRows?: boolean;
    skippedPreviewRows?: ReadonlySet<number>;
    now?: Date;
  }
): {
  autoSkippedFutureRows: number;
  autoSkippedInvalidDateRows: number;
  autoSkippedTotal: number;
  eligibleSessionRows: number;
  openSessionRows: number;
} {
  if (!rows || rows.length < 4) {
    return {
      autoSkippedFutureRows: 0,
      autoSkippedInvalidDateRows: 0,
      autoSkippedTotal: 0,
      eligibleSessionRows: 0,
      openSessionRows: 0,
    };
  }
  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) {
    return {
      autoSkippedFutureRows: 0,
      autoSkippedInvalidDateRows: 0,
      autoSkippedTotal: 0,
      eligibleSessionRows: 0,
      openSessionRows: 0,
    };
  }
  const headers = rows[headerRowIndex];
  if (!headers) {
    return {
      autoSkippedFutureRows: 0,
      autoSkippedInvalidDateRows: 0,
      autoSkippedTotal: 0,
      eligibleSessionRows: 0,
      openSessionRows: 0,
    };
  }
  const colIndices = findCoreColumnIndices(headers);
  if (colIndices.folien === -1 && colIndices.inhalt === -1) {
    return {
      autoSkippedFutureRows: 0,
      autoSkippedInvalidDateRows: 0,
      autoSkippedTotal: 0,
      eligibleSessionRows: 0,
      openSessionRows: 0,
    };
  }

  const now = options?.now ?? new Date();
  const skippedPreviewRows = options?.skippedPreviewRows ?? new Set<number>();
  const seenFolien = new Set<string>();
  let previewRowIndex = -1;
  let autoSkippedFutureRows = 0;
  const autoSkippedInvalidDateRows = 0;
  let eligibleSessionRows = 0;
  let openSessionRows = 0;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const folien = colIndices.folien !== -1 ? row[colIndices.folien] : '';
    const inhalt = colIndices.inhalt !== -1 ? row[colIndices.inhalt] : '';
    if (!folien && !inhalt) continue;
    if (options?.dedupeFolienRows) {
      const folienKey = normalizeFolienKey(folien);
      if (folienKey) {
        if (seenFolien.has(folienKey)) continue;
        seenFolien.add(folienKey);
      }
    }
    previewRowIndex += 1;
    if (skippedPreviewRows.has(previewRowIndex)) continue;

    const rawDate = colIndices.datum !== -1 ? row[colIndices.datum] : '';
    const parsedDate = parseSheetDate(rawDate != null ? String(rawDate) : null);
    const reason = classifySessionDateSkip(parsedDate, colIndices.datum !== -1, now);
    if (reason === 'future') {
      autoSkippedFutureRows += 1;
      continue;
    }
    eligibleSessionRows += 1;
    if (!parsedDate) openSessionRows += 1;
  }

  return {
    autoSkippedFutureRows,
    autoSkippedInvalidDateRows,
    autoSkippedTotal: autoSkippedFutureRows + autoSkippedInvalidDateRows,
    eligibleSessionRows,
    openSessionRows,
  };
}

export type WorkbookClassType = GroupClassType;

function detectClassType(title: string): WorkbookClassType | null {
  const normalized = title.trim();
  if (!normalized) return null;

  if (/\bonline_de\b/i.test(normalized)) return 'Online_DE';
  if (/\bonline_vn\b/i.test(normalized)) return 'Online_VN';
  if (/\boffline\b/i.test(normalized)) return 'Offline';

  // Single-letter class types can appear as standalone tokens or prefixes like "M22".
  const hasShortClassToken = (token: 'm' | 'a' | 'p'): boolean =>
    new RegExp(`(^|[^a-z0-9])${token}(?=\\d|[^a-z0-9]|$)`, 'i').test(normalized);
  if (hasShortClassToken('m')) return 'M';
  if (hasShortClassToken('a')) return 'A';
  if (hasShortClassToken('p')) return 'P';

  return null;
}

function resolveClassTypeForSync(workbookTitle: string, rawOverride: unknown): WorkbookClassType | null {
  const fromOverride = parseWorkbookClassTypeInput(rawOverride);
  if (fromOverride) return fromOverride;
  return detectClassType(workbookTitle);
}

export type { TeacherAliasResolution };

export type SyncProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number }
  /** One completed Supabase round-trip (or explicit batch) during import */
  | { type: 'db'; message: string };

type SheetParsedSession = {
  gridRowIndex: number;
  previewRowIndex: number;
  folien: string;
  parsedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  teacherCell: string | null;
  teacherParts: string[];
};

function sortDbLessonsForSync(
  lessons: { id: string; date: string | null; start_time: string | null }[]
): void {
  lessons.sort((a, b) => {
    const da = a.date as string | null | undefined;
    const db = b.date as string | null | undefined;
    if (!da && !db) {
      /* both null */
    } else if (!da) return 1;
    else if (!db) return -1;
    else if (da !== db) return String(da).localeCompare(String(db));

    const ta = a.start_time != null ? String(a.start_time) : '';
    const tb = b.start_time != null ? String(b.start_time) : '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.id).localeCompare(String(b.id));
  });
}

function storedLessonMatchesSheetSession(
  db: {
    slide_id: string | null;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    teacher: string | null;
  },
  session: SheetParsedSession
): boolean {
  const folienStr = session.folien.trim();
  if (normalizeFolienKey(folienStr) !== normalizeFolienKey(db.slide_id)) return false;
  const dbD = db.date != null ? String(db.date).slice(0, 10) : null;
  if ((session.parsedDate ?? null) !== (dbD ?? null)) return false;
  if (
    (session.startTime ?? null) !== (dbTimeToComparable(db.start_time) ?? null) ||
    (session.endTime ?? null) !== (dbTimeToComparable(db.end_time) ?? null)
  ) {
    return false;
  }
  if (
    normalizeTeacherCellForCompare(session.teacherCell) !== normalizeTeacherCellForCompare(db.teacher)
  ) {
    return false;
  }
  return true;
}

async function syncLessonAttendanceIncremental(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  lessonId: string,
  desired: { student_id: string; status: 'Present' | 'Absent'; feedback: string }[],
  sheetLabel: string,
  lessonHint: string,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
) {
  const want = new Map<string, { status: string; feedback: string }>();
  for (const r of desired) {
    want.set(r.student_id, { status: r.status, feedback: r.feedback });
  }

  const { data: existing, error: selErr } = await supabase
    .from('attendance_records')
    .select('id, student_id, status, feedback')
    .eq('lesson_id', lessonId);
  if (selErr) throw new Error(selErr.message);

  const byStudent = new Map((existing ?? []).map((r) => [r.student_id as string, r]));
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const toUpsert: { lesson_id: string; student_id: string; status: string; feedback: string }[] = [];

  for (const [sid, w] of want) {
    const row = byStudent.get(sid);
    if (!row) {
      toUpsert.push({
        lesson_id: lessonId,
        student_id: sid,
        status: w.status,
        feedback: w.feedback,
      });
      inserted++;
    } else {
      const same =
        String(row.status) === w.status && String(row.feedback ?? '').trim() === w.feedback.trim();
      if (!same) {
        toUpsert.push({
          lesson_id: lessonId,
          student_id: sid,
          status: w.status,
          feedback: w.feedback,
        });
        updated++;
      }
    }
  }
  if (toUpsert.length > 0) {
    const { error: upsertErr } = await supabase
      .from('attendance_records')
      .upsert(toUpsert, { onConflict: 'lesson_id,student_id' });
    if (upsertErr) throw new Error(upsertErr.message);
  }

  const removeIds: string[] = [];
  for (const [sid, row] of byStudent) {
    if (!want.has(sid)) removeIds.push(row.id as string);
  }
  if (removeIds.length > 0) {
    const { error: delErr } = await supabase.from('attendance_records').delete().in('id', removeIds);
    if (delErr) throw new Error(delErr.message);
    deleted = removeIds.length;
  }

  if (inserted + updated + deleted > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} attendance — ${lessonHint}: +${inserted} ~${updated} −${deleted}`,
    });
  }
}

async function syncOneCourseSheet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  groupId: string,
  sheetTitle: string,
  rows: SheetRow[] | undefined,
  teacherCache: Map<string, string>,
  canonicalTeacherNameById: Map<string, string>,
  colorAttendance: AttendanceFromColor[][] | undefined,
  studentCache: Map<string, string>,
  skippedPreviewRows: ReadonlySet<number>,
  skippedAttendanceCells: ReadonlySet<string>,
  sheetUrl: string | null,
  options?: { dedupeFolienRows?: boolean },
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<{
  ok: boolean;
  reason?: string;
  courseId?: string;
  syncCompleted?: boolean;
}> {
  const sheetLabel = `[${sheetTitle}]`;
  if (!rows || rows.length < 4) return { ok: false, reason: 'too_few_rows' };

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) return { ok: false, reason: 'no_header' };

  const headers = rows[headerRowIndex];
  if (!headers) return { ok: false, reason: 'no_header' };

  const colIndices = findCoreColumnIndices(headers);
  const lehrerCols = lehrerColumnIndices(headers);
  if (colIndices.folien === -1 && colIndices.inhalt === -1) return { ok: false, reason: 'no_course_columns' };

  const reservedColIndices: number[] = [
    colIndices.folien,
    colIndices.inhalt,
    colIndices.datum,
    colIndices.von,
    colIndices.bis,
    ...lehrerCols,
  ];
  const lehrerHeaderIdx = headers.findIndex((h) => h && /\blehrer\b/i.test(String(h).trim()));
  if (lehrerHeaderIdx >= 0) reservedColIndices.push(lehrerHeaderIdx);
  const maxReserved = Math.max(-1, ...reservedColIndices.filter((i) => i >= 0));
  const studentStartIndex = maxReserved + 1;
  const studentNames: { index: number; name: string }[] = [];
  for (let i = studentStartIndex; i < headers.length; i++) {
    const cell = headers[i];
    const trimmed = cell ? String(cell).trim() : '';
    if (!trimmed) continue;
    if (isNonStudentColumnHeader(trimmed)) continue;
    studentNames.push({ index: i, name: trimmed });
  }

  const uniqueStudentCols = dedupeSheetStudentColumns(studentNames);

  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} courses — select by group + name`,
  });
  const { data: existingCourses, error: existingCoursesErr } = await supabase
    .from('courses')
    .select('id, sheet_url')
    .eq('group_id', groupId)
    .eq('name', sheetTitle);
  if (existingCoursesErr) throw new Error(existingCoursesErr.message);

  let courseId: string;
  let existing: { id: string; sheet_url: string | null } | null = null;
  if ((existingCourses ?? []).length === 1) {
    existing = existingCourses![0] as { id: string; sheet_url: string | null };
  } else if ((existingCourses ?? []).length > 1) {
    const rows = (existingCourses ?? []) as { id: string; sheet_url: string | null }[];
    if (sheetUrl) {
      existing = rows.find((c) => courseDbUrlMatchesTabUrl(c.sheet_url, sheetUrl)) ?? null;
    }
    if (!existing) {
      // Fall back to a row without stored tab URL (legacy imports), else first row.
      existing = rows.find((c) => !(c.sheet_url ?? '').trim()) ?? rows[0] ?? null;
    }
  }

  if (existing?.id) {
    courseId = existing.id;
    const prevUrl = (existing.sheet_url ?? '').trim();
    const nextUrl = (sheetUrl ?? '').trim();
    if (sheetUrl && prevUrl !== nextUrl) {
      await onProgress?.({
        type: 'db',
        message: `${sheetLabel} courses — update sheet_url`,
      });
      const { error: sheetUrlErr } = await supabase
        .from('courses')
        .update({ sheet_url: sheetUrl })
        .eq('id', courseId);
      if (sheetUrlErr && !isSupabaseMissingColumnError(sheetUrlErr.message, 'sheet_url')) {
        throw new Error(`Failed to update course sheet_url "${sheetTitle}": ${sheetUrlErr.message}`);
      }
    }
  } else {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} courses — insert`,
    });
    let row: { id: string } | null = null;
    let createError = null as { message: string } | null;
    ({ data: row, error: createError } = await supabase
      .from('courses')
      .insert({ name: sheetTitle, group_id: groupId, sheet_url: sheetUrl })
      .select('id')
      .single());
    if (createError && isSupabaseMissingColumnError(createError.message, 'sheet_url')) {
      ({ data: row, error: createError } = await supabase
        .from('courses')
        .insert({ name: sheetTitle, group_id: groupId })
        .select('id')
        .single());
    }
    if (createError || !row) {
      throw new Error(`Failed to create course "${sheetTitle}": ${createError?.message ?? 'unknown'}`);
    }
    courseId = row.id;
  }

  const { data: existingEnrollRows, error: enrollSelErr } = await supabase
    .from('course_students')
    .select('student_id')
    .eq('course_id', courseId);
  if (enrollSelErr) throw new Error(enrollSelErr.message);
  const enrolledStudentIds = new Set((existingEnrollRows ?? []).map((r) => r.student_id as string));

  const missingStudentNames = [...new Set(uniqueStudentCols.map((c) => c.name).filter((name) => !studentCache.has(name)))];
  if (missingStudentNames.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} students — upsert ${missingStudentNames.length} row(s)`,
    });
    const { error: studentUpsertError } = await supabase
      .from('students')
      .upsert(
        missingStudentNames.map((name) => ({ group_id: groupId, name })),
        { onConflict: 'group_id,name' }
      );
    if (studentUpsertError) {
      throw new Error(`Failed to upsert students in group: ${studentUpsertError.message}`);
    }
    const { data: upsertedRows, error: upsertedSelErr } = await supabase
      .from('students')
      .select('id, name')
      .eq('group_id', groupId)
      .in('name', missingStudentNames);
    if (upsertedSelErr) throw new Error(`Failed to load upserted student ids: ${upsertedSelErr.message}`);
    for (const s of upsertedRows ?? []) {
      const name = String(s.name ?? '').trim();
      const id = String(s.id ?? '').trim();
      if (name && id) studentCache.set(name, id);
    }
  }

  const enrollRows: { course_id: string; student_id: string }[] = [];
  for (const col of uniqueStudentCols) {
    const name = col.name;
    const studentId = studentCache.get(name);
    if (!studentId) throw new Error(`Missing student id for "${name}" after upsert`);
    if (!enrolledStudentIds.has(studentId)) {
      enrollRows.push({ course_id: courseId, student_id: studentId });
      enrolledStudentIds.add(studentId);
    }
  }
  if (enrollRows.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_students — enroll ${enrollRows.length} row(s)`,
    });
    const { error: enrollError } = await supabase
      .from('course_students')
      .upsert(enrollRows, { onConflict: 'course_id,student_id' });
    if (enrollError) {
      throw new Error(`Failed to enroll students in course: ${enrollError.message}`);
    }
  }

  const studentMap: Record<string, string> = {};
  for (const col of uniqueStudentCols) {
    const sid = studentCache.get(col.name);
    if (sid) studentMap[col.name] = sid;
  }

  const teachersForCourse = new Set<string>();
  const sessionDrafts: SheetParsedSession[] = [];
  const sessions: SheetParsedSession[] = [];
  let previewRowIndex = -1;
  let skippedSessionRows = 0;
  let userSkippedSessionRows = 0;
  let autoSkippedFutureRows = 0;
  const autoSkippedInvalidDateRows = 0;
  const seenFolien = new Set<string>();
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const folien = colIndices.folien !== -1 ? row[colIndices.folien] : '';
    const inhalt = colIndices.inhalt !== -1 ? row[colIndices.inhalt] : '';
    if (!folien && !inhalt) continue;
    if (options?.dedupeFolienRows) {
      const folienKey = normalizeFolienKey(folien);
      if (folienKey) {
        if (seenFolien.has(folienKey)) continue;
        seenFolien.add(folienKey);
      }
    }
    previewRowIndex += 1;
    if (skippedPreviewRows.has(previewRowIndex)) {
      skippedSessionRows += 1;
      userSkippedSessionRows += 1;
      continue;
    }

    const rawDate = colIndices.datum !== -1 ? row[colIndices.datum] : '';
    const parsedDate = parseSheetDate(rawDate != null ? String(rawDate) : null);
    const startTime = normalizeTimeForDb(colIndices.von !== -1 ? row[colIndices.von] : null);
    const endTime = normalizeTimeForDb(colIndices.bis !== -1 ? row[colIndices.bis] : null);

    const teacherParts: string[] = [];
    const teacherColIndices =
      lehrerCols.length > 0
        ? lehrerCols
        : [headers.findIndex((h) => h && /\blehrer\b/i.test(String(h).trim()))].filter((idx) => idx >= 0);
    for (const idx of teacherColIndices) {
      teacherParts.push(...parseTeacherNames(row[idx]));
    }
    const canonicalLessonLabels: string[] = [];
    for (const part of teacherParts) {
      const nk = normalizePersonNameKey(part);
      const tid = nk ? teacherCache.get(nk) : undefined;
      const label = tid ? canonicalTeacherNameById.get(tid) ?? part : part;
      canonicalLessonLabels.push(label);
    }
    const teacherCell =
      canonicalLessonLabels.length > 0 ? [...new Set(canonicalLessonLabels)].join(', ') : null;

    sessionDrafts.push({
      gridRowIndex: i,
      previewRowIndex,
      folien: folien ? String(folien) : '',
      parsedDate,
      startTime,
      endTime,
      teacherCell,
      teacherParts,
    });
  }

  let trailingNoDateTeacher = true;
  const autoSkippedNoDateTeacherPreviewRows = new Set<number>();
  for (let i = sessionDrafts.length - 1; i >= 0; i--) {
    const sess = sessionDrafts[i];
    const noDateTeacher = !sess.parsedDate && !sess.teacherCell;
    if (trailingNoDateTeacher && noDateTeacher) {
      autoSkippedNoDateTeacherPreviewRows.add(sess.previewRowIndex);
    } else {
      trailingNoDateTeacher = false;
    }
  }

  for (const sess of sessionDrafts) {
    if (autoSkippedNoDateTeacherPreviewRows.has(sess.previewRowIndex)) {
      skippedSessionRows += 1;
      continue;
    }
    const dateSkipReason = classifySessionDateSkip(sess.parsedDate, colIndices.datum !== -1, new Date());
    if (dateSkipReason === 'future') {
      skippedSessionRows += 1;
      autoSkippedFutureRows += 1;
      continue;
    }
    sess.teacherParts.forEach((n) => teachersForCourse.add(n));
    sessions.push(sess);
  }

  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} lessons — load ${sessions.length} sheet session(s), merge with DB`,
  });
  const { data: dbLessonRows, error: lesErr } = await supabase
    .from('lessons')
    .select('id, slide_id, date, start_time, end_time, teacher')
    .eq('course_id', courseId);
  if (lesErr) throw new Error(lesErr.message);
  const dbLessons = [...(dbLessonRows ?? [])] as {
    id: string;
    slide_id: string | null;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    teacher: string | null;
  }[];
  sortDbLessonsForSync(dbLessons);

  if (dbLessons.length > sessions.length) {
    const dropIds = dbLessons.slice(sessions.length).map((l) => l.id);
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} lessons — delete ${dropIds.length} row(s) past sheet end`,
    });
    const { error: delLessErr } = await supabase.from('lessons').delete().in('id', dropIds);
    if (delLessErr) throw new Error(delLessErr.message);
    dbLessons.length = sessions.length;
  }

  await runWithConcurrencyLimit(sessions.length, LESSON_SYNC_CONCURRENCY, async (sIdx) => {
    const sess = sessions[sIdx];
    const row = rows[sess.gridRowIndex];
    if (!row) {
      throw new Error(`${sheetLabel} lessons — internal row lookup failed for parsed session index ${sIdx + 1}`);
    }

    const lessonHint = sess.parsedDate
      ? `date ${sess.parsedDate}`
      : sess.folien
        ? `slide ${sess.folien.slice(0, 40)}`
        : `row #${sIdx + 1}`;

    const attRow = colorAttendance?.[sess.gridRowIndex];
    const attendanceDesired: { student_id: string; status: 'Present' | 'Absent'; feedback: string }[] =
      [];
    for (const col of uniqueStudentCols) {
      if (skippedAttendanceCells.has(`${sIdx}:${col.name}`)) continue;
      const sid = studentMap[col.name];
      if (!sid) continue;
      const status = pickFirstAttendanceStatus(attRow, col.indices);
      if (status === null) continue;
      attendanceDesired.push({
        student_id: sid,
        status,
        feedback: mergedFeedbackFromRow(row, col.indices),
      });
    }

    if (sIdx < dbLessons.length) {
      const L = dbLessons[sIdx];
      if (!storedLessonMatchesSheetSession(L, sess)) {
        await onProgress?.({
          type: 'db',
          message: `${sheetLabel} lessons — update (${lessonHint})`,
        });
        const { error: upLesErr } = await supabase
          .from('lessons')
          .update({
            slide_id: sess.folien ? String(sess.folien) : null,
            date: sess.parsedDate,
            start_time: sess.startTime,
            end_time: sess.endTime,
            teacher: sess.teacherCell,
          })
          .eq('id', L.id);
        if (upLesErr) throw new Error(upLesErr.message);
      }
      // Keep existing attendance for already-stored sessions on re-import.
    } else {
      await onProgress?.({
        type: 'db',
        message: `${sheetLabel} lessons — insert (${lessonHint})`,
      });
      const { data: lesson, error: lessonError } = await supabase
        .from('lessons')
        .insert({
          course_id: courseId,
          slide_id: sess.folien ? String(sess.folien) : null,
          date: sess.parsedDate,
          start_time: sess.startTime,
          end_time: sess.endTime,
          teacher: sess.teacherCell,
        })
        .select('id')
        .single();

      if (lessonError || !lesson) {
        throw new Error(
          `${sheetLabel} lessons — insert failed (${lessonHint}): ${lessonError?.message ?? 'unknown error'}`
        );
      }
      await syncLessonAttendanceIncremental(
        supabase,
        lesson.id,
        attendanceDesired,
        sheetLabel,
        lessonHint,
        onProgress
      );
    }
  });

  await syncCourseTeachers(
    supabase,
    courseId,
    teachersForCourse,
    teacherCache,
    canonicalTeacherNameById,
    sheetLabel,
    onProgress
  );

  const courseSyncCompleted = isCourseSyncCompleted(
    autoSkippedFutureRows,
    autoSkippedInvalidDateRows,
    sessions.length,
    sessions.filter((sess) => !sess.parsedDate || !sess.teacherCell).length,
    skippedSessionRows
  );
  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} courses — sync_completed=${courseSyncCompleted} (course_id=${courseId}, user_skipped=${userSkippedSessionRows}, future_skipped=${autoSkippedFutureRows}, invalid_date_skipped=${autoSkippedInvalidDateRows}, total_skipped=${skippedSessionRows})`,
  });
  const { error: courseSyncFlagErr } = await supabase
    .from('courses')
    .update({ sync_completed: courseSyncCompleted })
    .eq('id', courseId);
  if (courseSyncFlagErr && !isSupabaseMissingColumnError(courseSyncFlagErr.message, 'sync_completed')) {
    throw new Error(courseSyncFlagErr.message);
  }
  const { data: verifyRow, error: verifyErr } = await supabase
    .from('courses')
    .select('id, sync_completed')
    .eq('id', courseId)
    .maybeSingle();
  if (verifyErr && !isSupabaseMissingColumnError(verifyErr.message, 'sync_completed')) {
    throw new Error(verifyErr.message);
  }
  if (verifyRow && Boolean(verifyRow.sync_completed) !== courseSyncCompleted) {
    throw new Error(
      `${sheetLabel} courses — sync_completed verification mismatch for ${courseId}: expected ${courseSyncCompleted}, got ${Boolean(verifyRow.sync_completed)}`
    );
  }

  return {
    ok: true,
    courseId,
    syncCompleted: courseSyncCompleted,
  };
}

export type SyncGoogleSheetResult =
  | { success: true; message: string }
  | { success: false; error: string };

/** Key format: `${visibleOrderIndex}:${sheetTitle}`; value: preview row indices to skip. */
export type SkippedRowsBySheet = Record<string, number[]>;
/** Key format: `${visibleOrderIndex}:${sheetTitle}`; value: `${previewRowIndex}:${studentName}` tokens. */
export type SkippedAttendanceCellsBySheet = Record<string, string[]>;

export { columnIndexToA1Letter };
export type { ScannedStudent };

/** One preview row: core columns in `values`, per-student cell color attendance (matches DB import). */
export type { ScannedSampleRow };

/** When the tab matches an existing course (name + sheet URL), preview only flags updates vs the database. */
export type ScannedSheetReimportDiff = {
  courseId: string;
  /** Sample row index → structural lesson column keys that differ from the stored lesson (Folien, Datum, von, bis, Lehrer). */
  changedCellsByRow: Record<number, string[]>;
  /** Tooltip copy for each cell in `changedCellsByRow` (same keys). */
  changeHintsByRow: Record<number, Record<string, string>>;
  /** Import-eligible rows with no paired existing lesson (positional), treated as new sessions. */
  newSessionRowIndices: number[];
  hasStructuralChanges: boolean;
};

export type ScannedSheet = {
  title: string;
  /** 0-based index among visible workbook tabs (API order), for current-course import cutoff. */
  visibleOrderIndex: number;
  /** Tab URL when known (Google); null for plain .xlsx. */
  sheetUrl: string | null;
  /** Completion inferred from Review Import analysis (auto-skipped future/invalid-date rows). */
  analyzedSyncCompleted?: boolean;
  headers: {
    folien?: string;
    datum?: string;
    von?: string;
    bis?: string;
    lehrer: string[];
    students: ScannedStudent[];
  };
  sampleRows: ScannedSampleRow[];
  /** Present when this tab maps to an existing course with lessons; UI highlights only changes. */
  reimportDiff?: ScannedSheetReimportDiff;
};

export type ScanGoogleSheetResult =
  | {
      success: true;
      /** Stable source identity for import: spreadsheet id when available, else xlsx hash key. */
      sourceKey: string;
      /** Spreadsheet id for DB group lookup when tied to a Google file; null for file-only imports. */
      groupSpreadsheetId: string | null;
      /** Canonical workbook URL when known (Google), else null. */
      spreadsheetUrl: string | null;
      workbookTitle: string;
      /** From workbook title: Online_DE, Online_VN, Offline substring match; null if none. */
      workbookClassType: WorkbookClassType | null;
      sheets: ScannedSheet[];
      /** Visible-tab index of the current course, or null if none qualifies. Sheets after this are not imported. */
      currentCourseVisibleIndex: number | null;
      /** Teacher names found in workbook rows but not present in the teachers table (or aliases). */
      detectedNewTeachers: string[];
      /** All teachers for linking sheet names as aliases in the preview modal. */
      existingTeachersForPicker: { id: string; name: string }[];
    }
  | { success: false; error: string };

export type ReviewedImportSnapshot = Extract<ScanGoogleSheetResult, { success: true }>;

export type ReviewedSnapshotImportPayload = {
  reviewSnapshot: ReviewedImportSnapshot;
  skippedRowsBySheet?: unknown;
  skippedAttendanceCellsBySheet?: unknown;
  teacherAliasResolutions?: unknown;
  workbookClassType?: unknown;
};

export type ParsedReviewedSnapshotImportPayload = {
  reviewSnapshot: ReviewedImportSnapshot;
  skippedRowsBySheet: SkippedRowsBySheet;
  skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet;
  teacherAliasResolutions?: TeacherAliasResolution[];
  workbookClassType?: unknown;
};

function isWorkbookClassType(v: unknown): v is WorkbookClassType {
  return (
    v === 'Online_DE' ||
    v === 'Online_VN' ||
    v === 'Offline' ||
    v === 'M' ||
    v === 'A' ||
    v === 'P'
  );
}

function isScannedSampleRow(value: unknown): value is ScannedSampleRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (!row.values || typeof row.values !== 'object') return false;
  if (!row.studentAttendance || typeof row.studentAttendance !== 'object') return false;
  return true;
}

function isScannedSheet(value: unknown): value is ScannedSheet {
  if (!value || typeof value !== 'object') return false;
  const sheet = value as Record<string, unknown>;
  if (typeof sheet.title !== 'string') return false;
  if (typeof sheet.visibleOrderIndex !== 'number' || !Number.isInteger(sheet.visibleOrderIndex)) return false;
  if (!(sheet.sheetUrl === null || typeof sheet.sheetUrl === 'string')) return false;
  if (!sheet.headers || typeof sheet.headers !== 'object') return false;
  if (!Array.isArray(sheet.sampleRows)) return false;
  return sheet.sampleRows.every((r) => isScannedSampleRow(r));
}

function parseMaybeObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function sanitizeSkipMap(raw: unknown): SkippedRowsBySheet {
  const obj = parseMaybeObjectRecord(raw);
  if (!obj) return {};
  const out: SkippedRowsBySheet = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    const ints = [...new Set(v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0))];
    if (ints.length > 0) out[k] = ints.sort((a, b) => a - b);
  }
  return out;
}

function sanitizeSkippedAttendanceMap(raw: unknown): SkippedAttendanceCellsBySheet {
  const obj = parseMaybeObjectRecord(raw);
  if (!obj) return {};
  const out: SkippedAttendanceCellsBySheet = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    const tokens = [...new Set(v.filter((s): s is string => typeof s === 'string' && s.includes(':')))];
    if (tokens.length > 0) out[k] = tokens.sort((a, b) => a.localeCompare(b));
  }
  return out;
}

export function parseReviewedSnapshotImportPayload(raw: unknown): {
  ok: true;
  value: ParsedReviewedSnapshotImportPayload;
} | {
  ok: false;
  error: string;
} {
  const body = parseMaybeObjectRecord(raw);
  if (!body) return { ok: false, error: 'Invalid request body' };
  const rs = body.reviewSnapshot;
  const snap = parseMaybeObjectRecord(rs);
  if (!snap) return { ok: false, error: 'Missing review snapshot' };
  if (snap.success !== true) return { ok: false, error: 'Review snapshot must be a successful scan result' };
  if (typeof snap.workbookTitle !== 'string' || snap.workbookTitle.trim() === '') {
    return { ok: false, error: 'Review snapshot is missing workbookTitle' };
  }
  if (typeof snap.sourceKey !== 'string' || snap.sourceKey.trim() === '') {
    return { ok: false, error: 'Review snapshot is missing sourceKey' };
  }
  if (!(snap.groupSpreadsheetId === null || typeof snap.groupSpreadsheetId === 'string')) {
    return { ok: false, error: 'Review snapshot has invalid groupSpreadsheetId' };
  }
  if (!(snap.spreadsheetUrl === null || typeof snap.spreadsheetUrl === 'string')) {
    return { ok: false, error: 'Review snapshot has invalid spreadsheetUrl' };
  }
  if (!(snap.workbookClassType === null || isWorkbookClassType(snap.workbookClassType))) {
    return { ok: false, error: 'Review snapshot has invalid workbookClassType' };
  }
  if (!(snap.currentCourseVisibleIndex === null || Number.isInteger(snap.currentCourseVisibleIndex))) {
    return { ok: false, error: 'Review snapshot has invalid currentCourseVisibleIndex' };
  }
  if (!Array.isArray(snap.sheets) || !snap.sheets.every((s) => isScannedSheet(s))) {
    return { ok: false, error: 'Review snapshot has invalid sheets' };
  }
  const sheetKeyInfo = new Map<
    string,
    { rowCount: number; studentNames: Set<string> }
  >();
  for (const sheet of snap.sheets as ScannedSheet[]) {
    const k = `${sheet.visibleOrderIndex}:${sheet.title}`;
    sheetKeyInfo.set(k, {
      rowCount: sheet.sampleRows.length,
      studentNames: new Set(sheet.headers.students.map((s) => s.name)),
    });
  }

  const skippedRowsBySheet = sanitizeSkipMap(body.skippedRowsBySheet);
  for (const [key, rows] of Object.entries(skippedRowsBySheet)) {
    const info = sheetKeyInfo.get(key);
    if (!info) return { ok: false, error: `Unknown sheet key in skippedRowsBySheet: ${key}` };
    if (rows.some((idx) => idx >= info.rowCount)) {
      return { ok: false, error: `Out-of-range row index in skippedRowsBySheet for ${key}` };
    }
  }

  const skippedAttendanceCellsBySheet = sanitizeSkippedAttendanceMap(body.skippedAttendanceCellsBySheet);
  for (const [key, tokens] of Object.entries(skippedAttendanceCellsBySheet)) {
    const info = sheetKeyInfo.get(key);
    if (!info) return { ok: false, error: `Unknown sheet key in skippedAttendanceCellsBySheet: ${key}` };
    for (const token of tokens) {
      const sep = token.indexOf(':');
      if (sep <= 0) return { ok: false, error: `Invalid attendance skip token "${token}" for ${key}` };
      const rowIndex = Number(token.slice(0, sep));
      const studentName = token.slice(sep + 1);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= info.rowCount) {
        return { ok: false, error: `Out-of-range attendance row index "${token}" for ${key}` };
      }
      if (!info.studentNames.has(studentName)) {
        return { ok: false, error: `Unknown student in attendance skip token "${token}" for ${key}` };
      }
    }
  }

  const teacherAliasRaw = body.teacherAliasResolutions;
  if (teacherAliasRaw != null && !Array.isArray(teacherAliasRaw)) {
    return { ok: false, error: 'teacherAliasResolutions must be a list of { aliasName, teacherId }' };
  }
  const teacherAliasResolutions = parseTeacherAliasResolutions(teacherAliasRaw);

  return {
    ok: true,
    value: {
      reviewSnapshot: snap as ReviewedImportSnapshot,
      skippedRowsBySheet,
      skippedAttendanceCellsBySheet,
      teacherAliasResolutions,
      workbookClassType: body.workbookClassType,
    },
  };
}

export type { SheetSyncSource };

export async function scanGoogleSheet(
  source: SheetSyncSource,
  options?: { onProgress?: (event: SyncProgressEvent) => void | Promise<void> }
): Promise<ScanGoogleSheetResult> {
  const onProgress = options?.onProgress;
  const supabase = getSupabaseAdmin();
  try {
    await onProgress?.({ type: 'status', message: 'Scanning workbook…' });
    const loaded = await loadWorkbookFromSource(source, onProgress);
    const workbookTitle = loaded.workbookTitle;
    await onProgress?.({
      type: 'status',
      message: `Scanning Workbook: ${workbookTitle}`,
    });
    let visibleSlotIndex = 0;
    const scannedSheets: ScannedSheet[] = [];
    const visibleSlots: { sampleRows: ScannedSampleRow[] }[] = [];
    const dedupeFolienRows = loaded.sourceKey.startsWith('xlsx:');

    for (const sheet of loaded.visibleSheets) {
      const title = sheet.title;
      const rows = sheet.rows;
      const colorAttendance = sheet.colorAttendance;
      const { sampleRows, scanned } = processVisibleSheetGrid(title, rows, colorAttendance, {
        dedupeFolienRows,
      });
      visibleSlots.push({ sampleRows });
      if (scanned) {
        scannedSheets.push({
          ...scanned,
          visibleOrderIndex: visibleSlotIndex,
          sheetUrl: sheet.sheetUrl ?? null,
        });
      }
      visibleSlotIndex++;
    }

    const titleClassType = detectClassType(workbookTitle);
    const initialAnalysisNow = new Date();
    for (const sh of scannedSheets) {
      const scannedSessionAnalysis = analyzeScannedSheetSessionsForImport(sh, initialAnalysisNow);
      sh.analyzedSyncCompleted = isCourseSyncCompleted(
        scannedSessionAnalysis.autoSkippedFutureRows,
        scannedSessionAnalysis.autoSkippedInvalidDateRows,
        scannedSessionAnalysis.eligibleRowIndices.length,
        scannedSessionAnalysis.openSessionRows
      );
    }
    let dbWorkbookClassType: WorkbookClassType | null = null;
    const groupLookupId = loaded.groupSpreadsheetId ?? null;
    if (groupLookupId) {
      await onProgress?.({ type: 'db', message: 'reimport diff — match courses to database' });
      const { data: grp, error: grpErr } = await supabase
        .from('groups')
        .select('id, class_type')
        .eq('spreadsheet_id', groupLookupId)
        .maybeSingle();
      if (!grpErr) {
        dbWorkbookClassType = parseWorkbookClassTypeInput(grp?.class_type);
      }
      if (!grpErr && grp?.id) {
        const { data: courseRows } = await supabase
          .from('courses')
          .select('id, name, sheet_url, sync_completed')
          .eq('group_id', grp.id);
        const courses = (courseRows ?? []) as ExistingCourseRow[];
        const courseIdBySheet = new Map<string, string>();
        const matchedCourseIds = new Set<string>();
        for (const sh of scannedSheets) {
          const hit = findExistingCourseForScannedTab(courses, sh.title, sh.sheetUrl);
          if (hit) {
            courseIdBySheet.set(`${sh.visibleOrderIndex}:${sh.title}`, hit.id);
            matchedCourseIds.add(hit.id);
          }
        }
        if (matchedCourseIds.size > 0) {
          const snapshotsMap = await loadLessonSnapshotsMapForCourses(
            supabase,
            [...matchedCourseIds],
            onProgress
          );
          const now = new Date();
          for (const sh of scannedSheets) {
            const cid = courseIdBySheet.get(`${sh.visibleOrderIndex}:${sh.title}`);
            if (!cid) continue;
            const snaps = snapshotsMap.get(cid) ?? [];
            const diff = buildReimportDiffForSheet(sh, cid, snaps, now);
            sh.reimportDiff = diff;
          }
        }
      }
    }

    const currentCourseVisibleIndex = findCurrentCourseVisibleIndex(visibleSlots, new Date());
    await onProgress?.({ type: 'db', message: 'teachers — load names + aliases (scan preview)' });
    const { teacherCache, existingTeachersForPicker } = await loadTeacherResolutionData(supabase);
    const existingTeacherNameKeys = new Set(teacherCache.keys());
    const detectedNewTeachers = collectTeacherNamesFromScannedSheets(scannedSheets).filter(
      (teacherName) => !existingTeacherNameKeys.has(normalizePersonNameKey(teacherName))
    );

    await onProgress?.({ type: 'status', message: 'Scan complete' });

    return {
      success: true,
      sourceKey: loaded.sourceKey,
      groupSpreadsheetId: loaded.groupSpreadsheetId,
      spreadsheetUrl: loaded.spreadsheetUrl,
      workbookTitle,
      workbookClassType: titleClassType ?? dbWorkbookClassType,
      sheets: scannedSheets,
      currentCourseVisibleIndex,
      detectedNewTeachers,
      existingTeachersForPicker,
    };
  } catch (error: unknown) {
    console.error('Scan error:', error);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errMsg };
  }
}

export async function runGoogleSheetSync(
  source: SheetSyncSource,
  options?: {
    onProgress?: (event: SyncProgressEvent) => void | Promise<void>;
    skippedRowsBySheet?: SkippedRowsBySheet;
    skippedAttendanceCellsBySheet?: SkippedAttendanceCellsBySheet;
    teacherAliasResolutions?: TeacherAliasResolution[];
    /** When workbook title does not contain Online_DE / Online_VN / Offline, pass the user’s choice from Review Import. */
    workbookClassType?: unknown;
  }
): Promise<SyncGoogleSheetResult> {
  const onProgress = options?.onProgress;
  const skippedRowsBySheet = options?.skippedRowsBySheet ?? {};
  const skippedAttendanceCellsBySheet = options?.skippedAttendanceCellsBySheet ?? {};
  const teacherAliasResolutions = options?.teacherAliasResolutions;
  const supabase = getSupabaseAdmin();
  try {
    const loaded = await loadWorkbookFromSource(source, onProgress);
    const workbookTitle = loaded.workbookTitle;
    const sourceKey = loaded.sourceKey;

    await onProgress?.({
      type: 'status',
      message: `Workbook: ${workbookTitle}`,
    });

    const groupLookupId = loaded.groupSpreadsheetId ?? sourceKey;
    let classType = resolveClassTypeForSync(workbookTitle, options?.workbookClassType);
    if (classType === null) {
      const { data: existingGroupForClass, error: groupClassErr } = await supabase
        .from('groups')
        .select('class_type')
        .eq('spreadsheet_id', groupLookupId)
        .maybeSingle();
      if (groupClassErr) throw new Error(groupClassErr.message);
      classType = parseWorkbookClassTypeInput(existingGroupForClass?.class_type);
    }
    if (classType === null) {
      return {
        success: false,
        error:
          'Class type is required: pick Online_DE, Online_VN, Offline, M, A, or P in Review Import, or add a token to the workbook title.',
      };
    }

    await onProgress?.({ type: 'db', message: 'teachers — load cache + aliases' });
    const { teacherCache, validTeacherIds, canonicalTeacherNameById } =
      await loadTeacherResolutionData(supabase);
    await applyTeacherAliasResolutions(
      supabase,
      teacherCache,
      teacherAliasResolutions,
      validTeacherIds,
      onProgress
    );

    await onProgress?.({ type: 'db', message: 'groups — select by spreadsheet_id' });
    const { data: existingGroup, error: groupSelectError } = await supabase
      .from('groups')
      .select('id, name, class_type, spreadsheet_url')
      .eq('spreadsheet_id', groupLookupId)
      .maybeSingle();

    if (groupSelectError) throw new Error(groupSelectError.message);
    let group: {
      id: string;
      name?: string | null;
      class_type?: string | null;
      spreadsheet_url?: string | null;
    } | null = existingGroup;

    if (!group) {
      await onProgress?.({ type: 'db', message: 'groups — insert' });
      const baseGroup = {
        name: workbookTitle,
        spreadsheet_id: groupLookupId,
        class_type: classType,
      };
      let inserted: { id: string } | null = null;
      let insertErr: { message: string } | null = null;
      ({ data: inserted, error: insertErr } = await supabase
        .from('groups')
        .insert({ ...baseGroup, spreadsheet_url: loaded.spreadsheetUrl })
        .select('id')
        .single());
      if (insertErr && isSupabaseMissingColumnError(insertErr.message, 'spreadsheet_url')) {
        ({ data: inserted, error: insertErr } = await supabase
          .from('groups')
          .insert(baseGroup)
          .select('id')
          .single());
      }
      if (insertErr || !inserted) {
        throw new Error(`Failed to create group: ${insertErr?.message ?? 'unknown'}`);
      }
      group = inserted;
    } else {
      const prevName = (existingGroup?.name ?? '').trim();
      const prevClass = existingGroup?.class_type ?? null;
      const prevUrl = (existingGroup?.spreadsheet_url ?? '').trim();
      const nextUrl = (loaded.spreadsheetUrl ?? '').trim();
      const groupNeedsUpdate =
        prevName !== workbookTitle.trim() ||
        prevClass !== classType ||
        (loaded.spreadsheetUrl != null && prevUrl !== nextUrl);

      if (groupNeedsUpdate) {
        await onProgress?.({ type: 'db', message: 'groups — update changed fields' });
        if (loaded.spreadsheetUrl) {
          const { error: upErr } = await supabase
            .from('groups')
            .update({
              name: workbookTitle,
              class_type: classType,
              spreadsheet_url: loaded.spreadsheetUrl,
            })
            .eq('id', group.id);
          if (upErr && isSupabaseMissingColumnError(upErr.message, 'spreadsheet_url')) {
            const { error: up2 } = await supabase
              .from('groups')
              .update({ name: workbookTitle, class_type: classType })
              .eq('id', group.id);
            if (up2) throw new Error(up2.message);
          } else if (upErr) {
            throw new Error(upErr.message);
          }
        } else {
          const { error: upErr } = await supabase
            .from('groups')
            .update({ name: workbookTitle, class_type: classType })
            .eq('id', group.id);
          if (upErr) throw new Error(upErr.message);
        }
      }
    }

    if (!group) {
      throw new Error('Internal error: group not resolved after load/insert');
    }

    await onProgress?.({ type: 'db', message: 'students — select by group_id (cache)' });
    const { data: groupStudents } = await supabase.from('students').select('id, name').eq('group_id', group.id);
    const studentCache = new Map<string, string>();
    for (const s of groupStudents ?? []) {
      studentCache.set(String(s.name).trim(), s.id);
    }

    const visibleSheetCount = loaded.visibleSheets.length;
    const dedupeFolienRows = loaded.sourceKey.startsWith('xlsx:');

    await onProgress?.({
      type: 'status',
      message: `Syncing ${visibleSheetCount} tab${visibleSheetCount === 1 ? '' : 's'}…`,
    });

    let synced = 0;
    let skipped = 0;
    let skippedAfterCurrentCourse = 0;
    const importedCourseIds: string[] = [];
    let visibleIndex = 0;
    let visibleSlotIndex = 0;
    const visibleSlots: { sampleRows: ScannedSampleRow[] }[] = [];
    const queued: {
      slotIndex: number;
      title: string;
      rows: SheetRow[];
      colorAttendance: AttendanceFromColor[][];
      sheetUrl: string | null;
    }[] = [];

    for (const sheet of loaded.visibleSheets) {
      const title = sheet.title;
      visibleIndex++;
      await onProgress?.({
        type: 'sheet',
        title,
        current: visibleIndex,
        total: visibleSheetCount,
      });

      const rows = sheet.rows;
      const colorAttendance = sheet.colorAttendance;
      const { sampleRows } = processVisibleSheetGrid(title, rows, colorAttendance, {
        dedupeFolienRows,
      });
      visibleSlots.push({ sampleRows });
      queued.push({
        slotIndex: visibleSlotIndex,
        title,
        rows: rows ?? [],
        colorAttendance: colorAttendance ?? [],
        sheetUrl: sheet.sheetUrl ?? null,
      });
      visibleSlotIndex++;
    }

    const currentCourseVisibleIndex = findCurrentCourseVisibleIndex(visibleSlots, new Date());

    for (const item of queued) {
      if (currentCourseVisibleIndex !== null && item.slotIndex > currentCourseVisibleIndex) {
        skipped++;
        skippedAfterCurrentCourse++;
        continue;
      }
      const result = await syncOneCourseSheet(
        supabase,
        group.id,
        item.title,
        item.rows,
        teacherCache,
        canonicalTeacherNameById,
        item.colorAttendance,
        studentCache,
        new Set(skippedRowsBySheet[`${item.slotIndex}:${item.title}`] ?? []),
        new Set(skippedAttendanceCellsBySheet[`${item.slotIndex}:${item.title}`] ?? []),
        item.sheetUrl,
        { dedupeFolienRows },
        onProgress
      );
      if (result.ok) {
        synced++;
        if (result.courseId) importedCourseIds.push(result.courseId);
      } else skipped++;
    }

    let allImportedCoursesCompleted = importedCourseIds.length > 0;
    if (importedCourseIds.length > 0) {
      const { data: completionRows, error: completionErr } = await supabase
        .from('courses')
        .select('id, sync_completed')
        .in('id', importedCourseIds);
      if (completionErr && !isSupabaseMissingColumnError(completionErr.message, 'sync_completed')) {
        throw new Error(completionErr.message);
      }
      if (completionRows) {
        allImportedCoursesCompleted = completionRows.every((r) => Boolean(r.sync_completed));
      }
    }

    const groupSyncCompleted = isGroupSyncCompleted(skippedAfterCurrentCourse, allImportedCoursesCompleted);
    await onProgress?.({
      type: 'db',
      message: `groups — sync_completed=${groupSyncCompleted}`,
    });
    const { error: groupSyncFlagErr } = await supabase
      .from('groups')
      .update({ sync_completed: groupSyncCompleted })
      .eq('id', group.id);
    if (groupSyncFlagErr && !isSupabaseMissingColumnError(groupSyncFlagErr.message, 'sync_completed')) {
      throw new Error(groupSyncFlagErr.message);
    }

    const skipHint =
      skippedAfterCurrentCourse > 0
        ? ` (${skippedAfterCurrentCourse} after the current course, not imported; other skips are empty/non-course layouts or hidden tabs)`
        : ' (empty or non-course layouts, or hidden tabs)';
    const message = `Sync completed: group "${workbookTitle}", ${synced} course sheet(s) imported, ${skipped} skipped${skipHint}.`;
    await onProgress?.({ type: 'status', message: 'Finishing…' });

    return {
      success: true,
      message,
    };
  } catch (error: unknown) {
    console.error('Sync error:', error);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errMsg };
  }
}

export async function runReviewedSnapshotSync(
  snapshot: ReviewedImportSnapshot,
  options?: {
    onProgress?: (event: SyncProgressEvent) => void | Promise<void>;
    skippedRowsBySheet?: SkippedRowsBySheet;
    skippedAttendanceCellsBySheet?: SkippedAttendanceCellsBySheet;
    teacherAliasResolutions?: TeacherAliasResolution[];
    workbookClassType?: unknown;
  }
): Promise<SyncGoogleSheetResult> {
  const onProgress = options?.onProgress;
  const skippedRowsBySheet = options?.skippedRowsBySheet ?? {};
  const skippedAttendanceCellsBySheet = options?.skippedAttendanceCellsBySheet ?? {};
  const teacherAliasResolutions = options?.teacherAliasResolutions;
  const supabase = getSupabaseAdmin();
  try {
    const workbookTitle = snapshot.workbookTitle;
    const groupLookupId = snapshot.groupSpreadsheetId ?? snapshot.sourceKey;
    let classType =
      parseWorkbookClassTypeInput(options?.workbookClassType) ??
      snapshot.workbookClassType ??
      detectClassType(workbookTitle);
    if (classType === null) {
      const { data: existingGroupForClass, error: groupClassErr } = await supabase
        .from('groups')
        .select('class_type')
        .eq('spreadsheet_id', groupLookupId)
        .maybeSingle();
      if (groupClassErr) throw new Error(groupClassErr.message);
      classType = parseWorkbookClassTypeInput(existingGroupForClass?.class_type);
    }
    if (classType === null) {
      return {
        success: false,
        error:
          'Class type is required: pick Online_DE, Online_VN, Offline, M, A, or P in Review Import, or add a token to the workbook title.',
      };
    }

    await onProgress?.({ type: 'db', message: 'teachers — load cache + aliases' });
    const { teacherCache, validTeacherIds, canonicalTeacherNameById } = await loadTeacherResolutionData(supabase);
    await applyTeacherAliasResolutions(
      supabase,
      teacherCache,
      teacherAliasResolutions,
      validTeacherIds,
      onProgress
    );

    await onProgress?.({ type: 'db', message: 'groups — select by spreadsheet_id' });
    const { data: existingGroup, error: groupSelectError } = await supabase
      .from('groups')
      .select('id, name, class_type, spreadsheet_url')
      .eq('spreadsheet_id', groupLookupId)
      .maybeSingle();
    if (groupSelectError) throw new Error(groupSelectError.message);

    let group: {
      id: string;
      name?: string | null;
      class_type?: string | null;
      spreadsheet_url?: string | null;
    } | null = existingGroup;

    if (!group) {
      await onProgress?.({ type: 'db', message: 'groups — insert' });
      const baseGroup = {
        name: workbookTitle,
        spreadsheet_id: groupLookupId,
        class_type: classType,
      };
      let inserted: { id: string } | null = null;
      let insertErr: { message: string } | null = null;
      ({ data: inserted, error: insertErr } = await supabase
        .from('groups')
        .insert({ ...baseGroup, spreadsheet_url: snapshot.spreadsheetUrl })
        .select('id')
        .single());
      if (insertErr && isSupabaseMissingColumnError(insertErr.message, 'spreadsheet_url')) {
        ({ data: inserted, error: insertErr } = await supabase.from('groups').insert(baseGroup).select('id').single());
      }
      if (insertErr || !inserted) throw new Error(`Failed to create group: ${insertErr?.message ?? 'unknown'}`);
      group = inserted;
    } else {
      const prevName = (existingGroup?.name ?? '').trim();
      const prevClass = existingGroup?.class_type ?? null;
      const prevUrl = (existingGroup?.spreadsheet_url ?? '').trim();
      const nextUrl = (snapshot.spreadsheetUrl ?? '').trim();
      const groupNeedsUpdate =
        prevName !== workbookTitle.trim() ||
        prevClass !== classType ||
        (snapshot.spreadsheetUrl != null && prevUrl !== nextUrl);
      if (groupNeedsUpdate) {
        await onProgress?.({ type: 'db', message: 'groups — update changed fields' });
        if (snapshot.spreadsheetUrl) {
          const { error: upErr } = await supabase
            .from('groups')
            .update({
              name: workbookTitle,
              class_type: classType,
              spreadsheet_url: snapshot.spreadsheetUrl,
            })
            .eq('id', group.id);
          if (upErr && isSupabaseMissingColumnError(upErr.message, 'spreadsheet_url')) {
            const { error: up2 } = await supabase
              .from('groups')
              .update({ name: workbookTitle, class_type: classType })
              .eq('id', group.id);
            if (up2) throw new Error(up2.message);
          } else if (upErr) {
            throw new Error(upErr.message);
          }
        } else {
          const { error: upErr } = await supabase
            .from('groups')
            .update({ name: workbookTitle, class_type: classType })
            .eq('id', group.id);
          if (upErr) throw new Error(upErr.message);
        }
      }
    }

    if (!group) throw new Error('Internal error: group not resolved after insert/select');

    await onProgress?.({ type: 'db', message: 'students — select by group_id (cache)' });
    const { data: groupStudents } = await supabase.from('students').select('id, name').eq('group_id', group.id);
    const studentCache = new Map<string, string>();
    for (const s of groupStudents ?? []) studentCache.set(String(s.name).trim(), s.id);

    const sheets = [...snapshot.sheets].sort((a, b) => a.visibleOrderIndex - b.visibleOrderIndex);
    const total = sheets.length;
    await onProgress?.({
      type: 'status',
      message: `Syncing ${total} reviewed tab${total === 1 ? '' : 's'}…`,
    });

    let synced = 0;
    let skipped = 0;
    let skippedAfterCurrentCourse = 0;
    const importedCourseIds: string[] = [];
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      await onProgress?.({
        type: 'sheet',
        title: sheet.title,
        current: i + 1,
        total,
      });
      const cutoff = snapshot.currentCourseVisibleIndex;
      if (cutoff !== null && sheet.visibleOrderIndex > cutoff) {
        skipped++;
        skippedAfterCurrentCourse++;
        continue;
      }
      const result = await syncOneScannedCourseSheet(
        supabase,
        group.id,
        sheet,
        teacherCache,
        canonicalTeacherNameById,
        studentCache,
        new Set(skippedRowsBySheet[`${sheet.visibleOrderIndex}:${sheet.title}`] ?? []),
        new Set(skippedAttendanceCellsBySheet[`${sheet.visibleOrderIndex}:${sheet.title}`] ?? []),
        onProgress
      );
      if (result.ok) {
        synced++;
        if (result.courseId) importedCourseIds.push(result.courseId);
      } else {
        skipped++;
      }
    }

    let allImportedCoursesCompleted = importedCourseIds.length > 0;
    if (importedCourseIds.length > 0) {
      const { data: completionRows, error: completionErr } = await supabase
        .from('courses')
        .select('id, sync_completed')
        .in('id', importedCourseIds);
      if (completionErr && !isSupabaseMissingColumnError(completionErr.message, 'sync_completed')) {
        throw new Error(completionErr.message);
      }
      if (completionRows) {
        allImportedCoursesCompleted = completionRows.every((r) => Boolean(r.sync_completed));
      }
    }

    const groupSyncCompleted = isGroupSyncCompleted(skippedAfterCurrentCourse, allImportedCoursesCompleted);
    await onProgress?.({
      type: 'db',
      message: `groups — sync_completed=${groupSyncCompleted}`,
    });
    const { error: groupSyncFlagErr } = await supabase
      .from('groups')
      .update({ sync_completed: groupSyncCompleted })
      .eq('id', group.id);
    if (groupSyncFlagErr && !isSupabaseMissingColumnError(groupSyncFlagErr.message, 'sync_completed')) {
      throw new Error(groupSyncFlagErr.message);
    }

    const skipHint =
      skippedAfterCurrentCourse > 0
        ? ` (${skippedAfterCurrentCourse} after the current course, not imported)`
        : '';
    const message = `Sync completed: group "${workbookTitle}", ${synced} reviewed course tab(s) imported, ${skipped} skipped${skipHint}.`;
    await onProgress?.({ type: 'status', message: 'Finishing…' });
    return { success: true, message };
  } catch (error: unknown) {
    console.error('Reviewed snapshot sync error:', error);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errMsg };
  }
}
