import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { dbTimeToComparable, normalizeTeacherCellForCompare, sheetStudentStatusForCompare } from '@/lib/sync/googleSheetReimportDiff';
import { isIsoDateStrictlyAfterLocalToday } from '@/lib/sync/currentCourseSheet';
import { datumChronoAppliesToRow, isDatumChronologyOutlier } from '@/lib/sync/sheetSessionDatumChronology';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { syncCourseTeachers } from '@/lib/sync/googleSheetTeacherSync';
import { getStudentCacheKey } from '@/lib/sync/googleSheetStudentSync';
import { isSupabaseMissingColumnError, upsertCourseInGroup } from '@/lib/sync/groupCourseUpsert';
import type { ScannedSheet, SyncProgressEvent } from '@/lib/sync/googleSheetSync';

const LESSON_SYNC_CONCURRENCY = 4;

type SyncOneScannedCourseSheetResult = {
  ok: boolean;
  reason?: string;
  courseId?: string;
  syncCompleted?: boolean;
  applySummary?: {
    sheetTitle: string;
    courseId: string;
    sessionsInserted: number;
    sessionsUpdated: number;
    sessionsDeleted: number;
    skippedSessionRows: number;
    syncCompleted: boolean;
  };
};

type SessionDateSkipReason = 'future' | null;

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
  void autoSkippedInvalidDateRows;
  void openSessionRows;
  return autoSkippedFutureRows === 0 && eligibleSessionRows > 0 && skippedSessionRows === 0;
}

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

function sortDbLessonsForSync(
  lessons: { id: string; date: string | null; start_time: string | null }[]
): void {
  lessons.sort((a, b) => {
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
  if (folienStr.toLowerCase().replace(/\s+/g, '') !== String(db.slide_id ?? '').toLowerCase().replace(/\s+/g, '')) {
    return false;
  }
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

export async function syncOneScannedCourseSheet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  groupId: string,
  scannedSheet: ScannedSheet,
  teacherCache: Map<string, string>,
  canonicalTeacherNameById: Map<string, string>,
  studentCache: Map<string, string>,
  skippedPreviewRows: ReadonlySet<number>,
  skippedAttendanceCells: ReadonlySet<string>,
  maxValidationRowIndex: number | null,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<SyncOneScannedCourseSheetResult> {
  const sheetTitle = scannedSheet.title;
  const sheetLabel = `[${sheetTitle}]`;
  const sheetUrl = scannedSheet.sheetUrl;
  const uniqueStudentNames = [...new Set(scannedSheet.headers.students.map((s) => s.name.trim()).filter(Boolean))];

  const { courseId } = await upsertCourseInGroup(supabase, {
    groupId,
    courseName: sheetTitle,
    sheetUrl,
    progressLabel: sheetLabel,
    onProgress,
  });

  const { data: existingEnrollRows, error: enrollSelErr } = await supabase
    .from('course_students')
    .select('student_id')
    .eq('course_id', courseId);
  if (enrollSelErr) throw new Error(enrollSelErr.message);
  const enrolledStudentIds = new Set((existingEnrollRows ?? []).map((r) => r.student_id as string));

  const missingStudentNames = uniqueStudentNames.filter((name) => !studentCache.has(getStudentCacheKey(name)));
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
    if (studentUpsertError) throw new Error(`Failed to upsert students in group: ${studentUpsertError.message}`);
    const { data: upsertedRows, error: upsertedSelErr } = await supabase
      .from('students')
      .select('id, name')
      .eq('group_id', groupId)
      .in('name', missingStudentNames);
    if (upsertedSelErr) throw new Error(`Failed to load upserted student ids: ${upsertedSelErr.message}`);
    for (const s of upsertedRows ?? []) {
      const name = String(s.name ?? '').trim();
      const id = String(s.id ?? '').trim();
      const nk = getStudentCacheKey(name);
      if (nk && id) studentCache.set(nk, id);
    }
  }

  const enrollRows: { course_id: string; student_id: string }[] = [];
  for (const name of uniqueStudentNames) {
    const studentId = studentCache.get(getStudentCacheKey(name));
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
    if (enrollError) throw new Error(`Failed to enroll students in course: ${enrollError.message}`);
  }

  const studentMap: Record<string, string> = {};
  for (const name of uniqueStudentNames) {
    const sid = studentCache.get(getStudentCacheKey(name));
    if (sid) studentMap[name] = sid;
  }

  const teachersForCourse = new Set<string>();
  const sessionDrafts: SheetParsedSession[] = [];
  const sessions: SheetParsedSession[] = [];
  let skippedSessionRows = 0;
  let userSkippedSessionRows = 0;
  let autoSkippedFutureRows = 0;
  let autoSkippedChronologyRows = 0;
  const autoSkippedInvalidDateRows = 0;
  let sessionsInserted = 0;
  let sessionsUpdated = 0;
  let sessionsDeleted = 0;
  const hasDatumColumn = Boolean(scannedSheet.headers.datum);
  for (let rowIndex = 0; rowIndex < scannedSheet.sampleRows.length; rowIndex++) {
    const row = scannedSheet.sampleRows[rowIndex];
    if (!row) continue;
    if (skippedPreviewRows.has(rowIndex)) {
      skippedSessionRows += 1;
      userSkippedSessionRows += 1;
      continue;
    }
    const parsedDate = parseSheetDate(String(row.values['Datum'] ?? ''));
    const teacherParts = parseTeacherNames(String(row.values['Lehrer'] ?? ''));
    const canonicalLessonLabels: string[] = [];
    for (const part of teacherParts) {
      const nk = normalizePersonNameKey(part);
      const tid = nk ? teacherCache.get(nk) : undefined;
      const label = tid ? canonicalTeacherNameById.get(tid) ?? part : part;
      canonicalLessonLabels.push(label);
    }
    const teacherCell = canonicalLessonLabels.length > 0 ? [...new Set(canonicalLessonLabels)].join(', ') : null;
    sessionDrafts.push({
      gridRowIndex: rowIndex,
      previewRowIndex: rowIndex,
      folien: String(row.values['Folien'] ?? ''),
      parsedDate,
      startTime: normalizeTimeForDb(String(row.values['von'] ?? '')),
      endTime: normalizeTimeForDb(String(row.values['bis'] ?? '')),
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

  const scannedSyncNow = new Date();
  const scannedChronoScope = {
    rowCount: scannedSheet.sampleRows.length,
    getDatumRaw: (i: number) => String(scannedSheet.sampleRows[i]?.values['Datum'] ?? ''),
    skippedRows: skippedPreviewRows,
    trailingNoDateTeacherRows: autoSkippedNoDateTeacherPreviewRows,
    maxValidationRowIndex,
    now: scannedSyncNow,
  };

  for (const sess of sessionDrafts) {
    if (autoSkippedNoDateTeacherPreviewRows.has(sess.previewRowIndex)) {
      skippedSessionRows += 1;
      continue;
    }
    const dateSkipReason = classifySessionDateSkip(sess.parsedDate, hasDatumColumn, scannedSyncNow);
    if (dateSkipReason === 'future') {
      skippedSessionRows += 1;
      autoSkippedFutureRows += 1;
      continue;
    }
    if (
      datumChronoAppliesToRow(scannedSheet.reimportDiff, sess.previewRowIndex) &&
      isDatumChronologyOutlier(scannedChronoScope, sess.previewRowIndex)
    ) {
      skippedSessionRows += 1;
      autoSkippedChronologyRows += 1;
      continue;
    }
    sess.teacherParts.forEach((n) => teachersForCourse.add(n));
    sessions.push(sess);
  }

  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} lessons — load ${sessions.length} reviewed session(s), merge with DB`,
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
      message: `${sheetLabel} lessons — delete ${dropIds.length} row(s) past reviewed end`,
    });
    const { error: delLessErr } = await supabase.from('lessons').delete().in('id', dropIds);
    if (delLessErr) throw new Error(delLessErr.message);
    dbLessons.length = sessions.length;
    sessionsDeleted += dropIds.length;
  }

  await runWithConcurrencyLimit(sessions.length, LESSON_SYNC_CONCURRENCY, async (sIdx) => {
    const sess = sessions[sIdx];
    const row = scannedSheet.sampleRows[sess.gridRowIndex];
    if (!row) throw new Error(`${sheetLabel} lessons — internal row lookup failed for session index ${sIdx + 1}`);
    const lessonHint = sess.parsedDate
      ? `date ${sess.parsedDate}`
      : sess.folien
        ? `slide ${sess.folien.slice(0, 40)}`
        : `row #${sIdx + 1}`;
    const attendanceDesired: { student_id: string; status: 'Present' | 'Absent'; feedback: string }[] = [];
    for (const name of uniqueStudentNames) {
      if (skippedAttendanceCells.has(`${sess.gridRowIndex}:${name}`)) continue;
      const sid = studentMap[name];
      if (!sid) continue;
      const status = sheetStudentStatusForCompare(row, name);
      if (status === null) continue;
      attendanceDesired.push({
        student_id: sid,
        status,
        feedback: String(row.values[name] ?? '').trim(),
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
        sessionsUpdated += 1;
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
      sessionsInserted += 1;
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
    message: `${sheetLabel} courses — sync_completed=${courseSyncCompleted} (course_id=${courseId}, user_skipped=${userSkippedSessionRows}, future_skipped=${autoSkippedFutureRows}, chrono_skipped=${autoSkippedChronologyRows}, invalid_date_skipped=${autoSkippedInvalidDateRows}, total_skipped=${skippedSessionRows})`,
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
    applySummary: {
      sheetTitle,
      courseId,
      sessionsInserted,
      sessionsUpdated,
      sessionsDeleted,
      skippedSessionRows,
      syncCompleted: courseSyncCompleted,
    },
  };
}
