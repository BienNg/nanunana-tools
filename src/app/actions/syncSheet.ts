'use server';

import { google } from 'googleapis';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

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
  // YYYY-MM-DD (already correct format)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/').map((p) => p.trim());
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // DD.MM.YYYY  (format the sheet instructions prescribe, e.g. "21.06.2024")
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [d, m, y] = s.split('.').map((p) => p.trim());
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

type SheetRow = string[];

function findHeaderRowIndex(rows: SheetRow[]): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    // The actual header row has "Folien" as its very first cell value (exact match).
    // We must NOT match rows where "Folien" only appears inside a long description text.
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

async function syncCourseTeachers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  courseId: string,
  teacherNames: Set<string>
) {
  await supabase.from('course_teachers').delete().eq('course_id', courseId);
  const names = [...teacherNames];
  if (names.length === 0) return;

  for (const name of names) {
    await supabase.from('teachers').upsert({ name }, { onConflict: 'name' });
  }
  const { data: teachers, error } = await supabase.from('teachers').select('id, name').in('name', names);
  if (error || !teachers?.length) return;

  const links = teachers.map((t) => ({ course_id: courseId, teacher_id: t.id }));
  await supabase.from('course_teachers').insert(links);
}

async function syncOneCourseSheet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  groupId: string,
  sheetTitle: string,
  rows: SheetRow[] | undefined
): Promise<{ ok: boolean; reason?: string }> {
  if (!rows || rows.length < 4) return { ok: false, reason: 'too_few_rows' };

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) return { ok: false, reason: 'no_header' };

  const headers = rows[headerRowIndex];
  if (!headers) return { ok: false, reason: 'no_header' };

  const colIndices = {
    folien: headers.findIndex((h) => h && String(h).includes('Folien') && !String(h).includes('gecheckt')),
    inhalt: headers.findIndex((h) => h && String(h).includes('Inhalt')),
    notizen: headers.findIndex((h) => h && String(h).includes('Notizen')),
    slidesChecked: headers.findIndex((h) => h && String(h).includes('gecheckt')),
    gemacht: headers.findIndex((h) => h && String(h).includes('gemacht')),
    datum: headers.findIndex((h) => h && String(h).includes('Datum')),
    von: headers.findIndex((h) => h && String(h).includes('von')),
    bis: headers.findIndex((h) => h && String(h).includes('bis')),
    nachrichten: headers.findIndex((h) => h && String(h).includes('Nachrichten')),
  };
  const lehrerCols = lehrerColumnIndices(headers);
  if (colIndices.folien === -1 && colIndices.inhalt === -1) return { ok: false, reason: 'no_course_columns' };

  const studentStartIndex =
    colIndices.nachrichten !== -1 ? colIndices.nachrichten + 1 : Math.max(10, ...lehrerCols) + 1;
  const studentNames: { index: number; name: string }[] = [];
  for (let i = studentStartIndex; i < headers.length; i++) {
    const cell = headers[i];
    if (cell && String(cell).trim() !== '') {
      studentNames.push({ index: i, name: String(cell).trim() });
    }
  }

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

  const studentRecords = studentNames.map((s) => ({ course_id: courseId, name: s.name }));
  for (const record of studentRecords) {
    await supabase.from('students').upsert(record, { onConflict: 'course_id,name' });
  }

  const { data: students } = await supabase.from('students').select('id, name').eq('course_id', courseId);
  if (!students) throw new Error('Failed to retrieve students');

  const studentMap: Record<string, string> = {};
  students.forEach((s) => {
    studentMap[s.name] = s.id;
  });

  await supabase.from('lessons').delete().eq('course_id', courseId);

  const teachersForCourse = new Set<string>();

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const folien = colIndices.folien !== -1 ? row[colIndices.folien] : '';
    const inhalt = colIndices.inhalt !== -1 ? row[colIndices.inhalt] : '';
    if (!folien && !inhalt) continue;

    const slidesCheckedStr =
      colIndices.slidesChecked !== -1 ? String(row[colIndices.slidesChecked] ?? '').toLowerCase() : '';
    const gemachtStr = colIndices.gemacht !== -1 ? String(row[colIndices.gemacht] ?? '').toLowerCase() : '';
    const isChecked = ['true', 'yes', 'x', 'v', '1', 'ja'].includes(slidesCheckedStr.trim());
    const isDone = ['true', 'yes', 'x', 'v', '1', 'ja'].includes(gemachtStr.trim());

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

    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .insert({
        course_id: courseId,
        slide_id: folien ? String(folien) : null,
        content: inhalt ? String(inhalt) : null,
        notes: colIndices.notizen !== -1 && row[colIndices.notizen] ? String(row[colIndices.notizen]) : null,
        slides_checked: isChecked,
        is_done: isDone,
        date: parsedDate,
        start_time: startTime,
        end_time: endTime,
        teacher: teacherCell,
        messages: colIndices.nachrichten !== -1 && row[colIndices.nachrichten]
          ? String(row[colIndices.nachrichten])
          : null,
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

    for (const student of studentNames) {
      const feedback = row[student.index] ? String(row[student.index]) : '';
      if (!feedback.trim()) continue;
      const sid = studentMap[student.name];
      if (!sid) continue;
      const lower = feedback.toLowerCase();
      const isAbsent = lower.includes('abwesend') || lower.includes('absent');
      attendanceInserts.push({
        lesson_id: lesson.id,
        student_id: sid,
        feedback,
        status: isAbsent ? 'Absent' : 'Present',
      });
    }

    if (attendanceInserts.length > 0) {
      await supabase.from('attendance_records').insert(attendanceInserts);
    }
  }

  await syncCourseTeachers(supabase, courseId, teachersForCourse);
  return { ok: true };
}

export async function syncGoogleSheet(url: string) {
  const supabase = getSupabaseAdmin();
  try {
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error('Invalid Google Sheets URL');

    const spreadsheetId = match[1];

    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is not configured in the environment');
    }

    const sheets = google.sheets({
      version: 'v4',
      auth: process.env.GOOGLE_API_KEY,
    });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const props = spreadsheet.data.properties;
    const workbookTitle = props?.title?.trim() || 'Imported workbook';

    let { data: group, error: groupSelectError } = await supabase
      .from('groups')
      .select('id')
      .eq('spreadsheet_id', spreadsheetId)
      .maybeSingle();

    if (groupSelectError) throw new Error(groupSelectError.message);

    if (!group) {
      const { data: inserted, error: insertErr } = await supabase
        .from('groups')
        .insert({ name: workbookTitle, spreadsheet_id: spreadsheetId })
        .select('id')
        .single();
      if (insertErr || !inserted) {
        throw new Error(`Failed to create group: ${insertErr?.message ?? 'unknown'}`);
      }
      group = inserted;
    } else {
      await supabase.from('groups').update({ name: workbookTitle }).eq('id', group.id);
    }

    const sheetList = spreadsheet.data.sheets ?? [];
    let synced = 0;
    let skipped = 0;

    for (const s of sheetList) {
      const title = s.properties?.title;
      if (!title) continue;
      if (s.properties?.hidden) {
        skipped++;
        continue;
      }

      const range = `${escapeSheetTitleForRange(title)}!A1:Z1000`;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      const rows = response.data.values as SheetRow[] | undefined;
      const result = await syncOneCourseSheet(supabase, group.id, title, rows);
      if (result.ok) synced++;
      else skipped++;
    }

    return {
      success: true,
      message: `Sync completed: group "${workbookTitle}", ${synced} course sheet(s) imported, ${skipped} skipped (empty or non-course tabs).`,
    };
  } catch (error: unknown) {
    console.error('Sync error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
