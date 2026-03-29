import { google, sheets_v4 } from 'googleapis';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

type AttendanceFromColor = 'Present' | 'Absent' | null;

function rgbFromCellFormat(fmt: sheets_v4.Schema$CellFormat | null | undefined): { r: number; g: number; b: number } | null {
  if (!fmt) return null;
  const rgb = fmt.backgroundColorStyle?.rgbColor ?? fmt.backgroundColor;
  if (!rgb) return null;
  const r = rgb.red ?? 0;
  const g = rgb.green ?? 0;
  const b = rgb.blue ?? 0;
  const a = rgb.alpha;
  if (a != null && a < 0.08) return null;
  return { r, g, b };
}

/** Green-dominant (any shade) → present; red-dominant → absent; white/gray/default → no row. */
function attendanceStatusFromRgb(r: number, g: number, b: number): AttendanceFromColor {
  if (r > 0.93 && g > 0.93 && b > 0.93) return null;
  if (r < 0.03 && g < 0.03 && b < 0.03) return null;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.03) return null;

  if (g > r) return 'Present';
  if (r > g) return 'Absent';
  return null;
}

function attendanceStatusFromCellData(cell: sheets_v4.Schema$CellData | undefined | null): AttendanceFromColor {
  if (!cell) return null;
  let rgb = rgbFromCellFormat(cell.effectiveFormat);
  if (!rgb) rgb = rgbFromCellFormat(cell.userEnteredFormat);
  if (!rgb) return null;
  return attendanceStatusFromRgb(rgb.r, rgb.g, rgb.b);
}

function cellStringFromCellData(cell: sheets_v4.Schema$CellData | undefined | null): string {
  if (!cell) return '';
  if (cell.formattedValue != null && cell.formattedValue !== '') return String(cell.formattedValue);
  const ev = cell.effectiveValue;
  if (!ev) return '';
  if (ev.stringValue != null) return String(ev.stringValue);
  if (ev.numberValue != null) return String(ev.numberValue);
  if (ev.boolValue != null) return String(ev.boolValue);
  return '';
}

function sheetGridToRowsAndColorAttendance(
  rowData: sheets_v4.Schema$RowData[] | null | undefined
): { rows: string[][]; colorAttendance: AttendanceFromColor[][] } {
  if (!rowData?.length) return { rows: [], colorAttendance: [] };

  let maxCols = 0;
  for (const rd of rowData) {
    maxCols = Math.max(maxCols, rd.values?.length ?? 0);
  }

  const rows: string[][] = [];
  const colorAttendance: AttendanceFromColor[][] = [];

  for (const rd of rowData) {
    const vals = rd.values ?? [];
    const row: string[] = [];
    const att: AttendanceFromColor[] = [];
    for (let c = 0; c < maxCols; c++) {
      const cell = vals[c];
      row.push(cellStringFromCellData(cell));
      att.push(attendanceStatusFromCellData(cell));
    }
    rows.push(row);
    colorAttendance.push(att);
  }

  return { rows, colorAttendance };
}

/** Escape a worksheet title for use in A1 notation: 'Sheet Name'!A1:Z */
function escapeSheetTitleForRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
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
  return null;
}

type ClassType = 'Online_DE' | 'Online_VN' | 'Offline';

function detectClassType(title: string): ClassType | null {
  if (title.includes('Online_DE')) return 'Online_DE';
  if (title.includes('Online_VN')) return 'Online_VN';
  if (title.includes('Offline')) return 'Offline';
  return null;
}

type SheetRow = string[];

function findHeaderRowIndex(rows: SheetRow[]): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (String(row[0] ?? '').trim() === 'Folien') return i;
  }
  return -1;
}

function lehrerColumnIndices(headers: SheetRow): number[] {
  const out: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    const t = String(h).toLowerCase();
    if (t.includes('lehrer')) out.push(i);
  }
  return out;
}

/** Headers for notes/messages columns that sit among student columns in the template. */
function isNonStudentColumnHeader(raw: string): boolean {
  const t = String(raw).trim().toLowerCase();
  if (!t) return true;
  if (t.includes('nachricht')) return true;
  if (t.includes('bemerkung')) return true;
  if (t.includes('notiz')) return true;
  if (t.includes('kommentar')) return true;
  return false;
}

/** One logical student per trimmed name; duplicate header columns share indices for attendance merge. */
type SheetStudentColumn = { indices: number[]; name: string };

function dedupeSheetStudentColumns(studentNames: { index: number; name: string }[]): SheetStudentColumn[] {
  const map = new Map<string, SheetStudentColumn>();
  for (const { index, name } of studentNames) {
    const key = name.trim();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { indices: [index], name: key });
    } else {
      prev.indices.push(index);
    }
  }
  return [...map.values()];
}

function pickFirstAttendanceStatus(
  attRow: AttendanceFromColor[] | undefined,
  indices: number[]
): AttendanceFromColor {
  for (const i of indices) {
    const s = attRow?.[i] ?? null;
    if (s !== null) return s;
  }
  return null;
}

function mergedFeedbackFromRow(row: SheetRow, indices: number[]): string {
  const parts: string[] = [];
  for (const i of indices) {
    const cell = row[i];
    const t = cell ? String(cell).trim() : '';
    if (t) parts.push(t);
  }
  return parts.join(' ').trim();
}

/**
 * Sync teachers for one course using an in-memory cache to avoid per-row DB calls.
 *
 * @param teacherCache  name → id for every teacher already in the DB (mutated in place when new teachers are inserted)
 */
async function syncCourseTeachers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  courseId: string,
  teacherNames: Set<string>,
  teacherCache: Map<string, string>
) {
  await supabase.from('course_teachers').delete().eq('course_id', courseId);
  const names = [...teacherNames];
  if (names.length === 0) return;

  // Check in memory first — only names truly missing from the cache need a DB insert.
  const newNames = names.filter((n) => !teacherCache.has(n));

  if (newNames.length > 0) {
    const { data: inserted } = await supabase
      .from('teachers')
      .insert(newNames.map((name) => ({ name })))
      .select('id, name');

    // Update the cache so subsequent courses don't re-insert the same teachers.
    (inserted ?? []).forEach((t: { id: string; name: string }) => {
      teacherCache.set(t.name, t.id);
    });
  }

  const links = names
    .map((n) => ({ course_id: courseId, teacher_id: teacherCache.get(n) }))
    .filter((l): l is { course_id: string; teacher_id: string } => Boolean(l.teacher_id));

  if (links.length > 0) {
    await supabase.from('course_teachers').insert(links);
  }
}

async function syncOneCourseSheet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  groupId: string,
  sheetTitle: string,
  rows: SheetRow[] | undefined,
  teacherCache: Map<string, string>,
  colorAttendance: AttendanceFromColor[][] | undefined,
  studentCache: Map<string, string>
): Promise<{ ok: boolean; reason?: string }> {
  if (!rows || rows.length < 4) return { ok: false, reason: 'too_few_rows' };

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) return { ok: false, reason: 'no_header' };

  const headers = rows[headerRowIndex];
  if (!headers) return { ok: false, reason: 'no_header' };

  const colIndices = {
    folien: headers.findIndex((h) => h && String(h).includes('Folien') && !String(h).includes('gecheckt')),
    inhalt: headers.findIndex((h) => h && String(h).includes('Inhalt')),
    datum: headers.findIndex((h) => h && String(h).includes('Datum')),
    von: headers.findIndex((h) => h && String(h).includes('von')),
    bis: headers.findIndex((h) => h && String(h).includes('bis')),
  };
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
  const lehrerHeaderIdx = headers.findIndex((h) => h && String(h).includes('Lehrer'));
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

  const { data: existing } = await supabase
    .from('courses')
    .select('id')
    .eq('group_id', groupId)
    .eq('name', sheetTitle)
    .maybeSingle();

  let courseId: string;
  if (existing?.id) {
    courseId = existing.id;
  } else {
    const { data: newCourse, error: createError } = await supabase
      .from('courses')
      .insert({ name: sheetTitle, group_id: groupId })
      .select('id')
      .single();
    if (createError || !newCourse) {
      throw new Error(`Failed to create course "${sheetTitle}": ${createError?.message ?? 'unknown'}`);
    }
    courseId = newCourse.id;
  }

  for (const col of uniqueStudentCols) {
    const name = col.name;
    let studentId = studentCache.get(name);
    if (!studentId) {
      const { data: row, error: studentUpsertError } = await supabase
        .from('students')
        .upsert({ group_id: groupId, name }, { onConflict: 'group_id,name' })
        .select('id')
        .single();
      const newId = row?.id;
      if (studentUpsertError || !newId) {
        throw new Error(
          `Failed to upsert student "${name}" in group: ${studentUpsertError?.message ?? 'unknown'}`
        );
      }
      studentId = newId;
      studentCache.set(name, newId);
    }

    const { error: enrollError } = await supabase
      .from('course_students')
      .upsert({ course_id: courseId, student_id: studentId }, { onConflict: 'course_id,student_id' });
    if (enrollError) {
      throw new Error(`Failed to enroll student "${name}" in course: ${enrollError.message}`);
    }
  }

  const studentMap: Record<string, string> = {};
  for (const col of uniqueStudentCols) {
    const sid = studentCache.get(col.name);
    if (sid) studentMap[col.name] = sid;
  }

  await supabase.from('lessons').delete().eq('course_id', courseId);

  const teachersForCourse = new Set<string>();

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const folien = colIndices.folien !== -1 ? row[colIndices.folien] : '';
    const inhalt = colIndices.inhalt !== -1 ? row[colIndices.inhalt] : '';
    if (!folien && !inhalt) continue;

    const rawDate = colIndices.datum !== -1 ? row[colIndices.datum] : '';
    const parsedDate = parseSheetDate(rawDate != null ? String(rawDate) : null);

    const startTime = normalizeTimeForDb(colIndices.von !== -1 ? row[colIndices.von] : null);
    const endTime = normalizeTimeForDb(colIndices.bis !== -1 ? row[colIndices.bis] : null);

    const teacherParts: string[] = [];
    const teacherColIndices =
      lehrerCols.length > 0
        ? lehrerCols
        : [headers.findIndex((h) => h && String(h).includes('Lehrer'))].filter((i) => i >= 0);
    for (const idx of teacherColIndices) {
      teacherParts.push(...parseTeacherNames(row[idx]));
    }
    teacherParts.forEach((n) => teachersForCourse.add(n));
    const teacherCell = teacherParts.length > 0 ? teacherParts.join(', ') : null;

    if (colIndices.datum !== -1 && !parsedDate) continue;

    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .insert({
        course_id: courseId,
        slide_id: folien ? String(folien) : null,
        content: inhalt ? String(inhalt) : null,
        date: parsedDate,
        start_time: startTime,
        end_time: endTime,
        teacher: teacherCell,
      })
      .select('id')
      .single();

    if (lessonError || !lesson) {
      console.error('Error inserting lesson:', lessonError);
      continue;
    }

    const attendanceInserts: {
      lesson_id: string;
      student_id: string;
      feedback: string;
      status: string;
    }[] = [];

    const attRow = colorAttendance?.[i];
    for (const col of uniqueStudentCols) {
      const sid = studentMap[col.name];
      if (!sid) continue;
      const status = pickFirstAttendanceStatus(attRow, col.indices);
      if (status === null) continue;
      const feedback = mergedFeedbackFromRow(row, col.indices);
      attendanceInserts.push({
        lesson_id: lesson.id,
        student_id: sid,
        feedback,
        status,
      });
    }

    if (attendanceInserts.length > 0) {
      await supabase.from('attendance_records').insert(attendanceInserts);
    }
  }

  await syncCourseTeachers(supabase, courseId, teachersForCourse, teacherCache);
  return { ok: true };
}

export type SyncProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number };

export type SyncGoogleSheetResult =
  | { success: true; message: string }
  | { success: false; error: string };

export async function runGoogleSheetSync(
  url: string,
  options?: { onProgress?: (event: SyncProgressEvent) => void | Promise<void> }
): Promise<SyncGoogleSheetResult> {
  const onProgress = options?.onProgress;
  const supabase = getSupabaseAdmin();
  try {
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error('Invalid Google Sheets URL');

    const spreadsheetId = match[1];

    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is not configured in the environment');
    }

    await onProgress?.({ type: 'status', message: 'Loading spreadsheet…' });

    const sheets = google.sheets({
      version: 'v4',
      auth: process.env.GOOGLE_API_KEY,
    });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const props = spreadsheet.data.properties;
    const workbookTitle = props?.title?.trim() || 'Imported workbook';

    await onProgress?.({
      type: 'status',
      message: `Workbook: ${workbookTitle}`,
    });

    // Load the full teachers table once so every per-course check is purely in-memory.
    const { data: allTeachers } = await supabase.from('teachers').select('id, name');
    const teacherCache = new Map<string, string>(
      (allTeachers ?? []).map((t: { id: string; name: string }) => [t.name, t.id])
    );

    const classType = detectClassType(workbookTitle);

    let { data: group, error: groupSelectError } = await supabase
      .from('groups')
      .select('id')
      .eq('spreadsheet_id', spreadsheetId)
      .maybeSingle();

    if (groupSelectError) throw new Error(groupSelectError.message);

    if (!group) {
      const { data: inserted, error: insertErr } = await supabase
        .from('groups')
        .insert({ name: workbookTitle, spreadsheet_id: spreadsheetId, class_type: classType })
        .select('id')
        .single();
      if (insertErr || !inserted) {
        throw new Error(`Failed to create group: ${insertErr?.message ?? 'unknown'}`);
      }
      group = inserted;
    } else {
      await supabase
        .from('groups')
        .update({ name: workbookTitle, class_type: classType })
        .eq('id', group.id);
    }

    const { data: groupStudents } = await supabase.from('students').select('id, name').eq('group_id', group.id);
    const studentCache = new Map<string, string>();
    for (const s of groupStudents ?? []) {
      studentCache.set(String(s.name).trim(), s.id);
    }

    const sheetList = spreadsheet.data.sheets ?? [];
    const visibleSheetCount = sheetList.filter(
      (s) => Boolean(s.properties?.title) && !s.properties?.hidden
    ).length;

    await onProgress?.({
      type: 'status',
      message: `Syncing ${visibleSheetCount} tab${visibleSheetCount === 1 ? '' : 's'}…`,
    });

    let synced = 0;
    let skipped = 0;
    let visibleIndex = 0;

    for (const s of sheetList) {
      const title = s.properties?.title;
      if (!title) continue;
      if (s.properties?.hidden) {
        skipped++;
        continue;
      }

      visibleIndex++;
      await onProgress?.({
        type: 'sheet',
        title,
        current: visibleIndex,
        total: visibleSheetCount,
      });

      const range = `${escapeSheetTitleForRange(title)}!A1:Z1000`;
      const gridResponse = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [range],
        includeGridData: true,
      });
      const sheetWithGrid = gridResponse.data.sheets?.find((sh) => sh.properties?.title === title);
      const rowData = sheetWithGrid?.data?.[0]?.rowData;
      const { rows, colorAttendance } = sheetGridToRowsAndColorAttendance(rowData);
      const result = await syncOneCourseSheet(
        supabase,
        group.id,
        title,
        rows,
        teacherCache,
        colorAttendance,
        studentCache
      );
      if (result.ok) synced++;
      else skipped++;
    }

    const message = `Sync completed: group "${workbookTitle}", ${synced} course sheet(s) imported, ${skipped} skipped (empty or non-course tabs).`;
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
