import { google, sheets_v4 } from 'googleapis';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { findCurrentCourseVisibleIndex, isIsoDateStrictlyAfterLocalToday } from '@/lib/sync/currentCourseSheet';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';

type AttendanceFromColor = 'Present' | 'Absent' | null;
type SheetRow = string[];

type LoadedVisibleSheet = {
  title: string;
  rows: SheetRow[];
  colorAttendance: AttendanceFromColor[][];
};

type LoadedWorkbook = {
  sourceKey: string;
  workbookTitle: string;
  visibleSheets: LoadedVisibleSheet[];
};

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

function parseSpreadsheetIdFromUrl(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? null;
}

function parseGoogleDriveFileIdFromUrl(url: string): string | null {
  const direct = url.match(/\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (direct?.[1]) return direct[1];
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id');
    return id && /^[a-zA-Z0-9-_]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function rgbFromArgbHex(argb: string | undefined): { r: number; g: number; b: number } | null {
  if (!argb) return null;
  const hex = argb.trim();
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const a = parseInt(hex.slice(0, 2), 16) / 255;
  if (a < 0.08) return null;
  const r = parseInt(hex.slice(2, 4), 16) / 255;
  const g = parseInt(hex.slice(4, 6), 16) / 255;
  const b = parseInt(hex.slice(6, 8), 16) / 255;
  return { r, g, b };
}

function attendanceStatusFromExcelCell(cell: ExcelJS.Cell): AttendanceFromColor {
  const fill = cell.style?.fill;
  if (!fill || fill.type !== 'pattern') return null;
  const fg = 'fgColor' in fill ? fill.fgColor : undefined;
  const bg = 'bgColor' in fill ? fill.bgColor : undefined;
  const rgb = rgbFromArgbHex(fg?.argb) ?? rgbFromArgbHex(bg?.argb);
  if (!rgb) return null;
  return attendanceStatusFromRgb(rgb.r, rgb.g, rgb.b);
}

function sanitizeSheetCellText(value: string): string {
  const s = value.trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return '';
  if (s === '[object Object]') return '';
  return s;
}

function looksLikeVerboseJsDateString(value: string): boolean {
  return /\bGMT[+-]\d{4}\b/i.test(value) && /\b\d{4}\b/.test(value);
}

function formatDateValueForSheet(raw: Date): string {
  if (Number.isNaN(raw.getTime())) return '';
  // Use UTC to avoid locale-specific historical offsets leaking into time-only cells.
  const y = raw.getUTCFullYear();
  const m = raw.getUTCMonth() + 1;
  const d = raw.getUTCDate();
  const hh = raw.getUTCHours();
  const mm = raw.getUTCMinutes();
  const ss = raw.getUTCSeconds();
  const hasDatePart = !(y === 1899 && m === 12 && d === 30);
  const hasTimePart = hh !== 0 || mm !== 0 || ss !== 0;
  if (!hasDatePart && hasTimePart) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  if (hasDatePart && !hasTimePart) {
    return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${String(y)}`;
  }
  if (hasDatePart && hasTimePart) {
    return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${String(y)} ${String(hh).padStart(
      2,
      '0'
    )}:${String(mm).padStart(2, '0')}`;
  }
  return '';
}

function cellStringFromExcelCell(cell: ExcelJS.Cell): string {
  const raw = cell.value;
  if (raw == null) return '';

  let rendered = '';
  try {
    rendered = typeof cell.text === 'string' ? sanitizeSheetCellText(cell.text) : '';
  } catch {
    rendered = '';
  }
  if (rendered && !looksLikeVerboseJsDateString(rendered)) return rendered;

  if (typeof raw === 'string') return sanitizeSheetCellText(raw);
  if (raw instanceof Date) {
    return formatDateValueForSheet(raw);
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return sanitizeSheetCellText(String(raw));
  }
  if (typeof raw === 'object') {
    if ('richText' in raw && Array.isArray(raw.richText)) {
      return sanitizeSheetCellText(raw.richText.map((part) => part?.text ?? '').join(''));
    }
    if ('text' in raw && typeof raw.text === 'string') {
      return sanitizeSheetCellText(raw.text);
    }
    if ('result' in raw && raw.result != null) {
      if (raw.result instanceof Date) return formatDateValueForSheet(raw.result);
      return sanitizeSheetCellText(String(raw.result));
    }
    if ('hyperlink' in raw && typeof raw.hyperlink === 'string') {
      return sanitizeSheetCellText(raw.hyperlink);
    }
  }
  try {
    return sanitizeSheetCellText(String(raw));
  } catch {
    return '';
  }
}

function sheetGridFromExcelWorksheet(worksheet: ExcelJS.Worksheet): {
  rows: SheetRow[];
  colorAttendance: AttendanceFromColor[][];
} {
  const maxRows = 1000;
  const maxCols = 26;
  const rows: SheetRow[] = [];
  const colorAttendance: AttendanceFromColor[][] = [];
  const rowLimit = Math.min(Math.max(worksheet.rowCount, 0), maxRows);

  for (let rowIdx = 1; rowIdx <= rowLimit; rowIdx++) {
    const row = worksheet.getRow(rowIdx);
    const values: string[] = [];
    const attendance: AttendanceFromColor[] = [];
    for (let colIdx = 1; colIdx <= maxCols; colIdx++) {
      const cell = row.getCell(colIdx);
      const text = cellStringFromExcelCell(cell);
      values.push(text);
      attendance.push(attendanceStatusFromExcelCell(cell));
    }
    rows.push(values);
    colorAttendance.push(attendance);
  }

  return { rows, colorAttendance };
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

function findHeaderRowIndex(rows: SheetRow[]): number {
  const normalizeHeaderCell = (value: string): string => {
    const base = value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .trim();
    return base;
  };

  const classifyHeader = (normalized: string): 'folien' | 'inhalt' | 'datum' | 'von' | 'bis' | 'lehrer' | null => {
    if (!normalized) return null;
    if (normalized === 'folien' || normalized === 'folie' || normalized === 'canva') return 'folien';
    if (normalized === 'inhalt' || normalized === 'ubersicht') return 'inhalt';
    if (normalized === 'datum' || normalized === 'unterrichtstag') return 'datum';
    if (normalized === 'von') return 'von';
    if (normalized === 'bis') return 'bis';
    if (normalized === 'lehrer') return 'lehrer';
    return null;
  };

  let bestIndex = -1;
  let bestScore = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const normalized = row.map((cell) => normalizeHeaderCell(String(cell ?? '')));
    const kinds = normalized.map(classifyHeader).filter((k): k is NonNullable<typeof k> => k !== null);
    const kindSet = new Set(kinds);
    const hasFolienLike = kindSet.has('folien') || kindSet.has('inhalt');
    const hasDatumLike = kindSet.has('datum');
    const hasTimeLike = kindSet.has('von') || kindSet.has('bis');
    const hasTeacherLike = kindSet.has('lehrer');
    if (!hasFolienLike) continue;
    if (!(hasDatumLike && (hasTeacherLike || hasTimeLike))) continue;
    const score = kindSet.size * 10 + kinds.length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function findCoreColumnIndices(headers: SheetRow): {
  folien: number;
  inhalt: number;
  datum: number;
  von: number;
  bis: number;
} {
  const normalizeHeaderCell = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .trim();

  let folien = -1;
  let inhalt = -1;
  let datum = -1;
  let von = -1;
  let bis = -1;

  for (let i = 0; i < headers.length; i++) {
    const raw = headers[i];
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const normalized = normalizeHeaderCell(text);
    if (folien === -1 && (normalized === 'folien' || normalized === 'folie' || normalized === 'canva')) folien = i;
    if (inhalt === -1 && (normalized === 'inhalt' || normalized === 'ubersicht')) inhalt = i;
    if (datum === -1 && (normalized === 'datum' || normalized === 'unterrichtstag')) datum = i;
    if (von === -1 && normalized === 'von') von = i;
    if (bis === -1 && normalized === 'bis') bis = i;
  }

  return { folien, inhalt, datum, von, bis };
}

function lehrerColumnIndices(headers: SheetRow): number[] {
  const out: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    const t = String(h).trim();
    if (/\blehrer\b/i.test(t)) out.push(i);
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

function normalizeFolienKey(value: string | undefined | null): string {
  return String(value ?? '').trim().toLowerCase();
}

export type SyncProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number }
  /** One completed Supabase round-trip (or explicit batch) during import */
  | { type: 'db'; message: string };

/**
 * Sync teachers for one course using an in-memory cache to avoid per-row DB calls.
 *
 * @param teacherCache  normalized-name key → id for every teacher already in the DB (mutated in place when new teachers are inserted)
 */
async function syncCourseTeachers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  courseId: string,
  teacherNames: Set<string>,
  teacherCache: Map<string, string>,
  sheetLabel: string,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
) {
  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} course_teachers — delete existing links for course`,
  });
  await supabase.from('course_teachers').delete().eq('course_id', courseId);
  const namesByKey = new Map<string, string>();
  for (const name of teacherNames) {
    const key = normalizePersonNameKey(name);
    if (!key || namesByKey.has(key)) continue;
    namesByKey.set(key, name);
  }
  const names = [...namesByKey.values()];
  if (names.length === 0) return;

  // Check in memory first — only names truly missing from the normalized cache need a DB insert.
  const newNames = names.filter((n) => !teacherCache.has(normalizePersonNameKey(n)));

  if (newNames.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} teachers — insert ${newNames.length} new row(s)`,
    });
    const { data: inserted } = await supabase
      .from('teachers')
      .insert(newNames.map((name) => ({ name })))
      .select('id, name');

    // Update the cache so subsequent courses don't re-insert the same teachers.
    (inserted ?? []).forEach((t: { id: string; name: string }) => {
      const key = normalizePersonNameKey(t.name);
      if (!key) return;
      teacherCache.set(key, t.id);
    });
  }

  const links = names
    .map((n) => ({ course_id: courseId, teacher_id: teacherCache.get(normalizePersonNameKey(n)) }))
    .filter((l): l is { course_id: string; teacher_id: string } => Boolean(l.teacher_id));

  if (links.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_teachers — insert ${links.length} link(s)`,
    });
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
  studentCache: Map<string, string>,
  skippedPreviewRows: ReadonlySet<number>,
  options?: { dedupeFolienRows?: boolean },
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<{ ok: boolean; reason?: string }> {
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
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} courses — insert`,
    });
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
      await onProgress?.({
        type: 'db',
        message: `${sheetLabel} students — upsert "${name}"`,
      });
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

    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_students — upsert enroll "${name}"`,
    });
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

  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} lessons — delete existing for course`,
  });
  await supabase.from('lessons').delete().eq('course_id', courseId);

  const teachersForCourse = new Set<string>();

  let lessonSeq = 0;
  let previewRowIndex = -1;
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
    if (skippedPreviewRows.has(previewRowIndex)) continue;

    const rawDate = colIndices.datum !== -1 ? row[colIndices.datum] : '';
    const parsedDate = parseSheetDate(rawDate != null ? String(rawDate) : null);
    if (parsedDate && isIsoDateStrictlyAfterLocalToday(parsedDate, new Date())) continue;

    const startTime = normalizeTimeForDb(colIndices.von !== -1 ? row[colIndices.von] : null);
    const endTime = normalizeTimeForDb(colIndices.bis !== -1 ? row[colIndices.bis] : null);

    const teacherParts: string[] = [];
    const teacherColIndices =
      lehrerCols.length > 0
        ? lehrerCols
        : [headers.findIndex((h) => h && /\blehrer\b/i.test(String(h).trim()))].filter((i) => i >= 0);
    for (const idx of teacherColIndices) {
      teacherParts.push(...parseTeacherNames(row[idx]));
    }
    teacherParts.forEach((n) => teachersForCourse.add(n));
    const teacherCell = teacherParts.length > 0 ? teacherParts.join(', ') : null;

    if (colIndices.datum !== -1 && !parsedDate) continue;

    lessonSeq += 1;
    const lessonHint = parsedDate
      ? `date ${parsedDate}`
      : folien
        ? `slide ${String(folien).slice(0, 40)}`
        : `row #${lessonSeq}`;
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} lessons — insert (${lessonHint})`,
    });
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
      await onProgress?.({
        type: 'db',
        message: `${sheetLabel} attendance_records — insert ${attendanceInserts.length} row(s) for ${lessonHint}`,
      });
      await supabase.from('attendance_records').insert(attendanceInserts);
    }
  }

  await syncCourseTeachers(supabase, courseId, teachersForCourse, teacherCache, sheetLabel, onProgress);
  return { ok: true };
}

export type SyncGoogleSheetResult =
  | { success: true; message: string }
  | { success: false; error: string };

/** Key format: `${visibleOrderIndex}:${sheetTitle}`; value: preview row indices to skip. */
export type SkippedRowsBySheet = Record<string, number[]>;

export function columnIndexToA1Letter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

export type ScannedStudent = { name: string; letters: string[] };

/** One preview row: core columns in `values`, per-student cell color attendance (matches DB import). */
export type ScannedSampleRow = {
  values: Record<string, string>;
  studentAttendance: Record<string, 'Present' | 'Absent' | null>;
};

export type ScannedSheet = {
  title: string;
  /** 0-based index among visible workbook tabs (API order), for current-course import cutoff. */
  visibleOrderIndex: number;
  headers: {
    folien?: string;
    datum?: string;
    von?: string;
    bis?: string;
    lehrer: string[];
    students: ScannedStudent[];
  };
  sampleRows: ScannedSampleRow[];
};

function collectTeacherNamesFromScannedSheets(sheets: ScannedSheet[]): string[] {
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

/**
 * Parse grid into preview rows + optional full scanned sheet (null when the tab is not a course layout).
 * Used by scan and sync so current-course detection matches import.
 */
function processVisibleSheetGrid(
  title: string,
  rows: SheetRow[] | undefined | null,
  colorAttendance: AttendanceFromColor[][] | undefined | null,
  options?: { dedupeFolienRows?: boolean }
): { sampleRows: ScannedSampleRow[]; scanned: Omit<ScannedSheet, 'visibleOrderIndex'> | null } {
  const empty: { sampleRows: ScannedSampleRow[]; scanned: null } = { sampleRows: [], scanned: null };
  if (!rows || rows.length < 4) return empty;

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) return empty;

  const headers = rows[headerRowIndex];
  if (!headers) return empty;

  const colIndices = findCoreColumnIndices(headers);
  const lehrerCols = lehrerColumnIndices(headers);
  if (colIndices.folien === -1 && colIndices.inhalt === -1) return empty;

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

  const scannedStudents: ScannedStudent[] = uniqueStudentCols.map((col) => ({
    name: col.name,
    letters: col.indices.map(columnIndexToA1Letter),
  }));

  const color = colorAttendance ?? [];
  const sampleRows: ScannedSampleRow[] = [];
  const seenFolien = new Set<string>();
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const folienRaw = colIndices.folien !== -1 ? row[colIndices.folien] : '';
    const inhaltRaw = colIndices.inhalt !== -1 ? row[colIndices.inhalt] : '';
    const folien = folienRaw != null ? String(folienRaw).trim() : '';
    const inhalt = inhaltRaw != null ? String(inhaltRaw).trim() : '';
    if (!folien && !inhalt) continue;
    if (options?.dedupeFolienRows) {
      const folienKey = normalizeFolienKey(folien);
      if (folienKey) {
        if (seenFolien.has(folienKey)) continue;
        seenFolien.add(folienKey);
      }
    }

    const rowValues: Record<string, string> = {};
    if (colIndices.folien !== -1) rowValues['Folien'] = String(row[colIndices.folien] || '');
    if (colIndices.datum !== -1) rowValues['Datum'] = String(row[colIndices.datum] || '');
    if (colIndices.von !== -1) rowValues['von'] = String(row[colIndices.von] || '');
    if (colIndices.bis !== -1) rowValues['bis'] = String(row[colIndices.bis] || '');

    const lehrerParts: string[] = [];
    const teacherColIndices =
      lehrerCols.length > 0 ? lehrerCols : [lehrerHeaderIdx].filter((idx) => idx >= 0);
    for (const idx of teacherColIndices) {
      lehrerParts.push(...parseTeacherNames(row[idx]));
    }
    if (teacherColIndices.length > 0) {
      rowValues['Lehrer'] = lehrerParts.join(', ');
    }

    const studentAttendance: Record<string, 'Present' | 'Absent' | null> = {};
    const attRow = color[i];
    for (const col of uniqueStudentCols) {
      let text = '';
      for (const idx of col.indices) {
        if (row[idx]) {
          text = String(row[idx]).trim();
          break;
        }
      }
      rowValues[col.name] = text;
      studentAttendance[col.name] = pickFirstAttendanceStatus(attRow, col.indices);
    }

    const rowHasAnyContent = Object.values(rowValues).some((v) => String(v).trim() !== '');
    if (!rowHasAnyContent) continue;

    sampleRows.push({ values: rowValues, studentAttendance });
  }

  const scanned: Omit<ScannedSheet, 'visibleOrderIndex'> = {
    title,
    headers: {
      folien: colIndices.folien !== -1 ? columnIndexToA1Letter(colIndices.folien) : undefined,
      datum: colIndices.datum !== -1 ? columnIndexToA1Letter(colIndices.datum) : undefined,
      von: colIndices.von !== -1 ? columnIndexToA1Letter(colIndices.von) : undefined,
      bis: colIndices.bis !== -1 ? columnIndexToA1Letter(colIndices.bis) : undefined,
      lehrer:
        lehrerCols.length > 0
          ? lehrerCols.map(columnIndexToA1Letter)
          : lehrerHeaderIdx >= 0
            ? [columnIndexToA1Letter(lehrerHeaderIdx)]
            : [],
      students: scannedStudents,
    },
    sampleRows,
  };

  return { sampleRows, scanned };
}

export type ScanGoogleSheetResult =
  | {
      success: true;
      workbookTitle: string;
      sheets: ScannedSheet[];
      /** Visible-tab index of the current course, or null if none qualifies. Sheets after this are not imported. */
      currentCourseVisibleIndex: number | null;
      /** Teacher names found in workbook rows but not present in the teachers table. */
      detectedNewTeachers: string[];
    }
  | { success: false; error: string };

export type SheetSyncSource = string | { fileName: string; bytes: Uint8Array };

async function loadWorkbookFromGoogleSheets(
  url: string,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<LoadedWorkbook> {
  const spreadsheetId = parseSpreadsheetIdFromUrl(url);
  if (!spreadsheetId) throw new Error('Invalid Google Sheets URL');

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not configured in the environment');
  }

  await onProgress?.({ type: 'status', message: 'Loading spreadsheet…' });
  const sheetsApi = google.sheets({
    version: 'v4',
    auth: process.env.GOOGLE_API_KEY,
  });

  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const workbookTitle = spreadsheet.data.properties?.title?.trim() || 'Imported workbook';
  const sheetList = spreadsheet.data.sheets ?? [];
  const visibleSheetCount = sheetList.filter(
    (s) => Boolean(s.properties?.title) && !s.properties?.hidden
  ).length;

  const visibleSheets: LoadedVisibleSheet[] = [];
  let visibleIndex = 0;
  for (const s of sheetList) {
    const title = s.properties?.title;
    if (!title || s.properties?.hidden) continue;

    visibleIndex++;
    await onProgress?.({ type: 'sheet', title, current: visibleIndex, total: visibleSheetCount });
    const range = `${escapeSheetTitleForRange(title)}!A1:Z1000`;
    const gridResponse = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      includeGridData: true,
    });
    const sheetWithGrid = gridResponse.data.sheets?.find((sh) => sh.properties?.title === title);
    const rowData = sheetWithGrid?.data?.[0]?.rowData;
    const { rows, colorAttendance } = sheetGridToRowsAndColorAttendance(rowData);
    visibleSheets.push({ title, rows, colorAttendance });
  }

  return {
    sourceKey: spreadsheetId,
    workbookTitle,
    visibleSheets,
  };
}

async function loadWorkbookFromXlsx(
  fileName: string,
  bytes: Uint8Array,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<LoadedWorkbook> {
  await onProgress?.({ type: 'status', message: 'Loading .xlsx workbook…' });
  const workbook = new ExcelJS.Workbook();
  const xlsxInput = Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(xlsxInput);
  const workbookTitle = fileName.replace(/\.xlsx$/i, '').trim() || 'Imported workbook';
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const sourceKey = `xlsx:${sourceHash}`;

  const visibleWorksheets = workbook.worksheets.filter(
    (ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden'
  );
  const visibleSheets: LoadedVisibleSheet[] = [];
  for (let i = 0; i < visibleWorksheets.length; i++) {
    const ws = visibleWorksheets[i];
    await onProgress?.({
      type: 'sheet',
      title: ws.name,
      current: i + 1,
      total: visibleWorksheets.length,
    });
    const { rows, colorAttendance } = sheetGridFromExcelWorksheet(ws);
    visibleSheets.push({ title: ws.name, rows, colorAttendance });
  }

  return { sourceKey, workbookTitle, visibleSheets };
}

async function loadWorkbookFromXlsxBytes(
  fileName: string,
  bytes: Uint8Array,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<LoadedWorkbook> {
  return loadWorkbookFromXlsx(fileName, bytes, onProgress);
}

function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim() || null;
    } catch {
      return utf8Match[1].trim() || null;
    }
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) return plainMatch[1].trim() || null;
  return null;
}

function fileNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (!last) return null;
    return decodeURIComponent(last).trim() || null;
  } catch {
    return null;
  }
}

async function fetchXlsxBytesFromUrl(url: string): Promise<{ bytes: Uint8Array; fileName: string | null }> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download .xlsx file: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const fileName =
    fileNameFromContentDisposition(response.headers.get('content-disposition')) ?? fileNameFromUrl(response.url);
  return { bytes: new Uint8Array(arrayBuffer), fileName };
}

async function loadWorkbookFromSource(
  source: SheetSyncSource,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<LoadedWorkbook> {
  if (typeof source === 'string') {
    const spreadsheetId = parseSpreadsheetIdFromUrl(source);
    if (spreadsheetId) {
      try {
        return await loadWorkbookFromGoogleSheets(source, onProgress);
      } catch {
        // Some Drive-hosted Office files can be opened in Sheets URLs but are not API-readable.
        // Fallback: try exporting/downloading as XLSX and parse locally.
        await onProgress?.({
          type: 'status',
          message: 'Sheets API failed, trying XLSX export…',
        });
        const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
        const downloaded = await fetchXlsxBytesFromUrl(exportUrl);
        return loadWorkbookFromXlsxBytes(downloaded.fileName ?? `${spreadsheetId}.xlsx`, downloaded.bytes, onProgress);
      }
    }

    const driveFileId = parseGoogleDriveFileIdFromUrl(source);
    if (driveFileId) {
      await onProgress?.({ type: 'status', message: 'Downloading Drive .xlsx file…' });
      const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${driveFileId}`;
      const downloaded = await fetchXlsxBytesFromUrl(directDownloadUrl);
      return loadWorkbookFromXlsxBytes(downloaded.fileName ?? `${driveFileId}.xlsx`, downloaded.bytes, onProgress);
    }

    if (/\.xlsx(?:\?|#|$)/i.test(source)) {
      await onProgress?.({ type: 'status', message: 'Downloading .xlsx file…' });
      const downloaded = await fetchXlsxBytesFromUrl(source);
      return loadWorkbookFromXlsxBytes(downloaded.fileName ?? 'downloaded.xlsx', downloaded.bytes, onProgress);
    }

    throw new Error('Unsupported URL: provide a Google Sheets URL or an accessible .xlsx URL');
  }
  return loadWorkbookFromXlsx(source.fileName, source.bytes, onProgress);
}

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
        scannedSheets.push({ ...scanned, visibleOrderIndex: visibleSlotIndex });
      }
      visibleSlotIndex++;
    }

    const currentCourseVisibleIndex = findCurrentCourseVisibleIndex(visibleSlots, new Date());
    await onProgress?.({ type: 'db', message: 'teachers — select all names (scan preview)' });
    const { data: allTeachers, error: teachersError } = await supabase.from('teachers').select('name');
    if (teachersError) throw new Error(teachersError.message);
    const existingTeacherNameKeys = new Set(
      (allTeachers ?? []).map((teacher: { name: string | null }) => normalizePersonNameKey(teacher.name)).filter(Boolean)
    );
    const detectedNewTeachers = collectTeacherNamesFromScannedSheets(scannedSheets).filter(
      (teacherName) => !existingTeacherNameKeys.has(normalizePersonNameKey(teacherName))
    );

    await onProgress?.({ type: 'status', message: 'Scan complete' });

    return {
      success: true,
      workbookTitle,
      sheets: scannedSheets,
      currentCourseVisibleIndex,
      detectedNewTeachers,
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
  }
): Promise<SyncGoogleSheetResult> {
  const onProgress = options?.onProgress;
  const skippedRowsBySheet = options?.skippedRowsBySheet ?? {};
  const supabase = getSupabaseAdmin();
  try {
    const loaded = await loadWorkbookFromSource(source, onProgress);
    const workbookTitle = loaded.workbookTitle;
    const sourceKey = loaded.sourceKey;

    await onProgress?.({
      type: 'status',
      message: `Workbook: ${workbookTitle}`,
    });

    // Load the full teachers table once so every per-course check is purely in-memory.
    await onProgress?.({ type: 'db', message: 'teachers — select all (cache)' });
    const { data: allTeachers } = await supabase.from('teachers').select('id, name');
    const teacherCache = new Map<string, string>(
      (allTeachers ?? [])
        .map((t: { id: string; name: string }) => [normalizePersonNameKey(t.name), t.id] as const)
        .filter(([key]) => Boolean(key))
    );

    const classType = detectClassType(workbookTitle);

    await onProgress?.({ type: 'db', message: 'groups — select by spreadsheet_id' });
    const { data: existingGroup, error: groupSelectError } = await supabase
      .from('groups')
      .select('id')
      .eq('spreadsheet_id', sourceKey)
      .maybeSingle();

    if (groupSelectError) throw new Error(groupSelectError.message);
    let group = existingGroup;

    if (!group) {
      await onProgress?.({ type: 'db', message: 'groups — insert' });
      const { data: inserted, error: insertErr } = await supabase
        .from('groups')
        .insert({ name: workbookTitle, spreadsheet_id: sourceKey, class_type: classType })
        .select('id')
        .single();
      if (insertErr || !inserted) {
        throw new Error(`Failed to create group: ${insertErr?.message ?? 'unknown'}`);
      }
      group = inserted;
    } else {
      await onProgress?.({ type: 'db', message: 'groups — update name and class_type' });
      await supabase
        .from('groups')
        .update({ name: workbookTitle, class_type: classType })
        .eq('id', group.id);
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
    let visibleIndex = 0;
    let visibleSlotIndex = 0;
    const visibleSlots: { sampleRows: ScannedSampleRow[] }[] = [];
    const queued: {
      slotIndex: number;
      title: string;
      rows: SheetRow[];
      colorAttendance: AttendanceFromColor[][];
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
        item.colorAttendance,
        studentCache,
        new Set(skippedRowsBySheet[`${item.slotIndex}:${item.title}`] ?? []),
        { dedupeFolienRows },
        onProgress
      );
      if (result.ok) synced++;
      else skipped++;
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
