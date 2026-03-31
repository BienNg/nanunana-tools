import { google, sheets_v4 } from 'googleapis';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { parseSpreadsheetIdFromUrl } from '@/lib/googleSheets/parseSpreadsheetIdFromUrl';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { findCurrentCourseVisibleIndex, isIsoDateStrictlyAfterLocalToday } from '@/lib/sync/currentCourseSheet';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import type { GroupClassType } from '@/lib/courseDuration';
import { parseWorkbookClassTypeInput } from '@/lib/courseDuration';

type AttendanceFromColor = 'Present' | 'Absent' | null;
type SheetRow = string[];

type LoadedVisibleSheet = {
  title: string;
  rows: SheetRow[];
  colorAttendance: AttendanceFromColor[][];
  /** Per-tab Google Sheets URL (`…/edit#gid=…`); null when not available (e.g. .xlsx import). */
  sheetUrl: string | null;
};

type LoadedWorkbook = {
  sourceKey: string;
  /**
   * Google spreadsheet id for `groups.spreadsheet_id` lookup.
   * Set when this workbook is tied to a Google file (API load or XLSX export fallback), else null.
   */
  groupSpreadsheetId: string | null;
  workbookTitle: string;
  /** Workbook URL (`…/spreadsheets/d/{id}/edit`); null for file-only imports. */
  spreadsheetUrl: string | null;
  visibleSheets: LoadedVisibleSheet[];
};

function canonicalGoogleSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function googleSheetTabUrl(spreadsheetId: string, sheetId: number): string {
  return `${canonicalGoogleSpreadsheetUrl(spreadsheetId)}#gid=${sheetId}`;
}

/** PostgREST when the column was never migrated / not in schema cache yet. */
function isSupabaseMissingColumnError(message: string | undefined, column: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const col = column.toLowerCase();
  return m.includes(col) && (m.includes('schema cache') || m.includes('could not find'));
}

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

/** Map a sheet spelling to an existing teacher during import; persisted as `teacher_aliases`. */
export type TeacherAliasResolution = { aliasName: string; teacherId: string };

export type SyncProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number }
  /** One completed Supabase round-trip (or explicit batch) during import */
  | { type: 'db'; message: string };

async function loadTeacherResolutionData(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<{
  teacherCache: Map<string, string>;
  existingTeachersForPicker: { id: string; name: string }[];
  validTeacherIds: Set<string>;
  /** Canonical `teachers.name` for display on imported lessons (id → name). */
  canonicalTeacherNameById: Map<string, string>;
}> {
  const { data: allTeachers, error: teachersError } = await supabase.from('teachers').select('id, name');
  if (teachersError) throw new Error(teachersError.message);

  const canonicalTeacherNameById = new Map<string, string>();
  const teacherCache = new Map<string, string>();
  for (const t of allTeachers ?? []) {
    canonicalTeacherNameById.set(t.id, t.name);
    const key = normalizePersonNameKey(t.name);
    if (key) teacherCache.set(key, t.id);
  }

  const { data: aliasRows, error: aliasesError } = await supabase
    .from('teacher_aliases')
    .select('teacher_id, normalized_key');
  if (aliasesError) throw new Error(aliasesError.message);

  for (const row of aliasRows ?? []) {
    const nk = String(row.normalized_key ?? '').trim();
    const tid = row.teacher_id as string | undefined;
    if (!nk || !tid) continue;
    const existing = teacherCache.get(nk);
    if (existing && existing !== tid) {
      console.warn(
        `[sync] teacher_aliases normalized_key "${nk}" maps to ${tid} but cache already had ${existing}; skipping alias row`
      );
      continue;
    }
    teacherCache.set(nk, tid);
  }

  const existingTeachersForPicker = [...(allTeachers ?? [])]
    .map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const validTeacherIds = new Set((allTeachers ?? []).map((t: { id: string }) => t.id));

  return { teacherCache, existingTeachersForPicker, validTeacherIds, canonicalTeacherNameById };
}

async function applyTeacherAliasResolutions(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  teacherCache: Map<string, string>,
  resolutions: TeacherAliasResolution[] | undefined,
  validTeacherIds: Set<string>,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
) {
  if (!resolutions?.length) return;
  for (const { aliasName, teacherId } of resolutions) {
    if (!validTeacherIds.has(teacherId)) {
      throw new Error(`Unknown teacher for alias "${aliasName}"`);
    }
    const trimmed = String(aliasName).trim();
    const nk = normalizePersonNameKey(trimmed);
    if (!nk) continue;
    await onProgress?.({
      type: 'db',
      message: `teacher_aliases — upsert "${trimmed}"`,
    });
    const { error } = await supabase.from('teacher_aliases').upsert(
      { teacher_id: teacherId, alias: trimmed, normalized_key: nk },
      { onConflict: 'normalized_key' }
    );
    if (error) throw new Error(error.message);
    teacherCache.set(nk, teacherId);
  }
}

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
  canonicalTeacherNameById: Map<string, string>,
  sheetLabel: string,
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
) {
  const namesByKey = new Map<string, string>();
  for (const name of teacherNames) {
    const key = normalizePersonNameKey(name);
    if (!key || namesByKey.has(key)) continue;
    namesByKey.set(key, name);
  }
  const names = [...namesByKey.values()];

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

    (inserted ?? []).forEach((t: { id: string; name: string }) => {
      const key = normalizePersonNameKey(t.name);
      if (!key) return;
      teacherCache.set(key, t.id);
      canonicalTeacherNameById.set(t.id, t.name);
    });
  }

  const desiredTeacherIds = new Set<string>();
  for (const n of names) {
    const tid = teacherCache.get(normalizePersonNameKey(n));
    if (tid) desiredTeacherIds.add(tid);
  }

  const { data: existingLinks, error: linkSelErr } = await supabase
    .from('course_teachers')
    .select('teacher_id')
    .eq('course_id', courseId);
  if (linkSelErr) throw new Error(linkSelErr.message);
  const existingIds = new Set((existingLinks ?? []).map((r) => r.teacher_id as string));

  const toRemove = [...existingIds].filter((id) => !desiredTeacherIds.has(id));
  const toAdd = [...desiredTeacherIds].filter((id) => !existingIds.has(id));

  if (toRemove.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_teachers — remove ${toRemove.length} link(s)`,
    });
    await supabase.from('course_teachers').delete().eq('course_id', courseId).in('teacher_id', toRemove);
  }
  if (toAdd.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_teachers — add ${toAdd.length} link(s)`,
    });
    await supabase
      .from('course_teachers')
      .insert(toAdd.map((teacher_id) => ({ course_id: courseId, teacher_id })));
  }
}

type SheetParsedSession = {
  gridRowIndex: number;
  folien: string;
  parsedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  teacherCell: string | null;
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

  for (const [sid, w] of want) {
    const row = byStudent.get(sid);
    if (!row) {
      const { error: insErr } = await supabase.from('attendance_records').insert({
        lesson_id: lessonId,
        student_id: sid,
        status: w.status,
        feedback: w.feedback,
      });
      if (insErr) throw new Error(insErr.message);
      inserted++;
    } else {
      const same =
        String(row.status) === w.status && String(row.feedback ?? '').trim() === w.feedback.trim();
      if (!same) {
        const { error: upErr } = await supabase
          .from('attendance_records')
          .update({ status: w.status, feedback: w.feedback })
          .eq('id', row.id);
        if (upErr) throw new Error(upErr.message);
        updated++;
      }
    }
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
  sheetUrl: string | null,
  options?: { dedupeFolienRows?: boolean },
  onProgress?: (event: SyncProgressEvent) => void | Promise<void>
): Promise<{ ok: boolean; reason?: string; hadSkippedSessions?: boolean }> {
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
    .select('id, sheet_url')
    .eq('group_id', groupId)
    .eq('name', sheetTitle)
    .maybeSingle();

  let courseId: string;
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
    if (!studentId) {
      throw new Error(`Missing student id for "${name}" after upsert`);
    }

    if (!enrolledStudentIds.has(studentId)) {
      await onProgress?.({
        type: 'db',
        message: `${sheetLabel} course_students — enroll "${name}"`,
      });
      const { error: enrollError } = await supabase
        .from('course_students')
        .upsert({ course_id: courseId, student_id: studentId }, { onConflict: 'course_id,student_id' });
      if (enrollError) {
        throw new Error(`Failed to enroll student "${name}" in course: ${enrollError.message}`);
      }
      enrolledStudentIds.add(studentId);
    }
  }

  const studentMap: Record<string, string> = {};
  for (const col of uniqueStudentCols) {
    const sid = studentCache.get(col.name);
    if (sid) studentMap[col.name] = sid;
  }

  const teachersForCourse = new Set<string>();
  const sessions: SheetParsedSession[] = [];
  let previewRowIndex = -1;
  let skippedSessionRows = 0;
  let userSkippedSessionRows = 0;
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
    if (parsedDate && isIsoDateStrictlyAfterLocalToday(parsedDate, new Date())) {
      skippedSessionRows += 1;
      continue;
    }

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
    teacherParts.forEach((n) => teachersForCourse.add(n));
    const canonicalLessonLabels: string[] = [];
    for (const part of teacherParts) {
      const nk = normalizePersonNameKey(part);
      const tid = nk ? teacherCache.get(nk) : undefined;
      const label = tid ? canonicalTeacherNameById.get(tid) ?? part : part;
      canonicalLessonLabels.push(label);
    }
    const teacherCell =
      canonicalLessonLabels.length > 0 ? [...new Set(canonicalLessonLabels)].join(', ') : null;

    if (colIndices.datum !== -1 && !parsedDate) {
      skippedSessionRows += 1;
      continue;
    }

    sessions.push({
      gridRowIndex: i,
      folien: folien ? String(folien) : '',
      parsedDate,
      startTime,
      endTime,
      teacherCell,
    });
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

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const sess = sessions[sIdx];
    const row = rows[sess.gridRowIndex];
    if (!row) {
      skippedSessionRows += 1;
      continue;
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
      await syncLessonAttendanceIncremental(
        supabase,
        L.id,
        attendanceDesired,
        sheetLabel,
        lessonHint,
        onProgress
      );
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
        console.error('Error inserting lesson:', lessonError);
        skippedSessionRows += 1;
        continue;
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
  }

  await syncCourseTeachers(
    supabase,
    courseId,
    teachersForCourse,
    teacherCache,
    canonicalTeacherNameById,
    sheetLabel,
    onProgress
  );

  const courseSyncCompleted = userSkippedSessionRows === 0;
  await onProgress?.({
    type: 'db',
    message: `${sheetLabel} courses — sync_completed=${courseSyncCompleted} (user_skipped=${userSkippedSessionRows}, total_skipped=${skippedSessionRows})`,
  });
  const { error: courseSyncFlagErr } = await supabase
    .from('courses')
    .update({ sync_completed: courseSyncCompleted })
    .eq('id', courseId);
  if (courseSyncFlagErr && !isSupabaseMissingColumnError(courseSyncFlagErr.message, 'sync_completed')) {
    throw new Error(courseSyncFlagErr.message);
  }

  return { ok: true, hadSkippedSessions: userSkippedSessionRows > 0 };
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

/** When the tab matches an existing course (name + sheet URL), preview only flags updates vs the database. */
export type ScannedSheetReimportDiff = {
  courseId: string;
  /** Sample row index → column keys that differ from the stored lesson (Folien, Datum, von, bis, Lehrer, or student name). */
  changedCellsByRow: Record<number, string[]>;
  /** Tooltip copy for each cell in `changedCellsByRow` (same keys). */
  changeHintsByRow: Record<number, Record<string, string>>;
  /** Existing DB course is not completed yet; allow re-import to refresh completion flags even without content diffs. */
  pendingCompletionSync?: boolean;
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

function parseGidFromGoogleSheetUrl(url: string): string | null {
  const m = url.match(/[#&]gid=(\d+)/i);
  return m?.[1] ?? null;
}

/** Same spreadsheet tab for course matching during scan (legacy rows may omit `sheet_url`). */
function courseDbUrlMatchesTabUrl(dbUrl: string | null | undefined, tabUrl: string | null): boolean {
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

function normalizeTeacherCellForCompare(raw: string | undefined | null): string {
  const parts = parseTeacherNames(raw)
    .map((p) => normalizePersonNameKey(p))
    .filter(Boolean)
    .sort();
  return parts.join('|');
}

function dbTimeToComparable(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const m = String(value).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return normalizeTimeForDb(value);
  const hh = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const ss = (m[3] ?? '00').padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function sheetStudentStatusForCompare(row: ScannedSampleRow, studentName: string): 'Present' | 'Absent' | null {
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

function dbAttendanceStatusToken(status: string): 'Present' | 'Absent' | null {
  if (status === 'Present' || status === 'Absent') return status;
  return null;
}

function reimportAttendanceLine(status: 'Present' | 'Absent' | null, feedback: string): string {
  const parts: string[] = [];
  if (status === 'Present' || status === 'Absent') parts.push(status);
  else parts.push('no mark');
  const fb = feedback.trim();
  if (fb) parts.push(`note “${fb}”`);
  return parts.join(', ');
}

/**
 * Sample row indices eligible for lesson import (matches syncOneCourseSheet with empty user skips).
 * `rIdx === previewRowIndex` for each row in sampleRows.
 */
function eligibleImportSampleRowIndices(sheet: ScannedSheet, now: Date): number[] {
  const datumCol = Boolean(sheet.headers.datum);
  const out: number[] = [];
  for (let rIdx = 0; rIdx < sheet.sampleRows.length; rIdx++) {
    const row = sheet.sampleRows[rIdx];
    const parsedDate = parseSheetDate(row.values['Datum'] ?? '');
    if (datumCol && !parsedDate) continue;
    if (parsedDate && isIsoDateStrictlyAfterLocalToday(parsedDate, now)) continue;
    out.push(rIdx);
  }
  return out;
}

type LessonCompareSnapshot = {
  slide_id: string | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  teacher: string | null;
  attendanceByStudentName: Map<string, { status: string; feedback: string }>;
};

async function loadLessonSnapshotsMapForCourses(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  courseIds: string[],
  studentIdToName: Map<string, string>,
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
      /* both null — order by time then id */
    } else if (!da) return 1;
    else if (!db) return -1;
    else if (da !== db) return String(da).localeCompare(String(db));

    const ta = a.start_time != null ? String(a.start_time) : '';
    const tb = b.start_time != null ? String(b.start_time) : '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.id).localeCompare(String(b.id));
  });

  const lessonIds = lessons.map((l) => l.id as string);
  const { data: records, error: attErr } = await supabase
    .from('attendance_records')
    .select('lesson_id, student_id, status, feedback')
    .in('lesson_id', lessonIds);
  if (attErr) throw new Error(attErr.message);

  const attByLesson = new Map<string, Map<string, { status: string; feedback: string }>>();
  for (const r of records ?? []) {
    const lid = r.lesson_id as string;
    const sid = r.student_id as string;
    const name = studentIdToName.get(sid);
    if (!name) continue;
    let m = attByLesson.get(lid);
    if (!m) {
      m = new Map();
      attByLesson.set(lid, m);
    }
    m.set(name, { status: String(r.status), feedback: String(r.feedback ?? '') });
  }

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
      attendanceByStudentName: attByLesson.get(L.id as string) ?? new Map(),
    });
  }
  return out;
}

function buildReimportDiffForSheet(
  sheet: ScannedSheet,
  courseId: string,
  dbLessons: LessonCompareSnapshot[],
  now: Date
): ScannedSheetReimportDiff {
  const eligible = eligibleImportSampleRowIndices(sheet, now);
  const changedCellsByRow: Record<number, string[]> = {};
  const changeHintsByRow: Record<number, Record<string, string>> = {};
  const newSessionRowIndices: number[] = [];

  for (let i = 0; i < eligible.length; i++) {
    const rIdx = eligible[i];
    const row = sheet.sampleRows[rIdx];
    const lesson = dbLessons[i];
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
        `Folien / slides: was “${reimportHintDisplayCell(lesson.slide_id)}” — sheet now “${reimportHintDisplayCell(row.values['Folien'])}”.`
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
        `Teacher: was “${reimportHintDisplayCell(lesson.teacher)}” — sheet now “${reimportHintDisplayCell(row.values['Lehrer'])}”.`
      );
    }

    for (const st of sheet.headers.students) {
      const name = st.name;
      const stSheet = sheetStudentStatusForCompare(row, name);
      const fbSheet = String(row.values[name] ?? '').trim();
      const dbRec = lesson.attendanceByStudentName.get(name);
      if (!dbRec) {
        if (stSheet !== null || fbSheet !== '') {
          track(
            name,
            `${name}: no attendance was stored — sheet now ${reimportAttendanceLine(stSheet, fbSheet)}.`
          );
        }
      } else {
        const dbSt = dbAttendanceStatusToken(dbRec.status);
        if (stSheet !== dbSt) {
          track(
            name,
            `${name}: was ${reimportAttendanceLine(dbSt, dbRec.feedback)} — sheet now ${reimportAttendanceLine(stSheet, fbSheet)}.`
          );
        } else if (fbSheet !== (dbRec.feedback ?? '').trim()) {
          track(
            name,
            `${name}: note was “${reimportHintDisplayCell(dbRec.feedback)}” — sheet now “${reimportHintDisplayCell(fbSheet)}”.`
          );
        }
      }
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
): {
  sampleRows: ScannedSampleRow[];
  scanned: Omit<ScannedSheet, 'visibleOrderIndex' | 'sheetUrl' | 'reimportDiff'> | null;
} {
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
      // Must match syncOneCourseSheet: feedback persisted as merged text from all columns (e.g. K, L, M).
      rowValues[col.name] = mergedFeedbackFromRow(row, col.indices);
      studentAttendance[col.name] = pickFirstAttendanceStatus(attRow, col.indices);
    }

    const rowHasAnyContent = Object.values(rowValues).some((v) => String(v).trim() !== '');
    if (!rowHasAnyContent) continue;

    sampleRows.push({ values: rowValues, studentAttendance });
  }

  const scanned: Omit<ScannedSheet, 'visibleOrderIndex' | 'sheetUrl' | 'reimportDiff'> = {
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
    const gid = s.properties?.sheetId;
    const sheetUrl =
      typeof gid === 'number' ? googleSheetTabUrl(spreadsheetId, gid) : null;
    visibleSheets.push({ title, rows, colorAttendance, sheetUrl });
  }

  return {
    sourceKey: spreadsheetId,
    groupSpreadsheetId: spreadsheetId,
    workbookTitle,
    spreadsheetUrl: canonicalGoogleSpreadsheetUrl(spreadsheetId),
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
    visibleSheets.push({ title: ws.name, rows, colorAttendance, sheetUrl: null });
  }

  return { sourceKey, groupSpreadsheetId: null, workbookTitle, spreadsheetUrl: null, visibleSheets };
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
        const fromXlsx = await loadWorkbookFromXlsxBytes(
          downloaded.fileName ?? `${spreadsheetId}.xlsx`,
          downloaded.bytes,
          onProgress
        );
        return {
          ...fromXlsx,
          spreadsheetUrl: canonicalGoogleSpreadsheetUrl(spreadsheetId),
          groupSpreadsheetId: spreadsheetId,
        };
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
        scannedSheets.push({
          ...scanned,
          visibleOrderIndex: visibleSlotIndex,
          sheetUrl: sheet.sheetUrl ?? null,
        });
      }
      visibleSlotIndex++;
    }

    const groupLookupId = loaded.groupSpreadsheetId ?? null;
    if (groupLookupId) {
      await onProgress?.({ type: 'db', message: 'reimport diff — match courses to database' });
      const { data: grp, error: grpErr } = await supabase
        .from('groups')
        .select('id')
        .eq('spreadsheet_id', groupLookupId)
        .maybeSingle();
      if (!grpErr && grp?.id) {
        const [cRes, sRes] = await Promise.all([
          supabase.from('courses').select('id, name, sheet_url, sync_completed').eq('group_id', grp.id),
          supabase.from('students').select('id, name').eq('group_id', grp.id),
        ]);
        const courses = cRes.data ?? [];
        const studentIdToName = new Map(
          (sRes.data ?? []).map((s) => [s.id as string, String(s.name)])
        );
        const courseIdBySheet = new Map<string, string>();
        const matchedCourseIds = new Set<string>();
        for (const sh of scannedSheets) {
          const hit = courses.find(
            (c) => c.name === sh.title && courseDbUrlMatchesTabUrl(c.sheet_url, sh.sheetUrl)
          );
          if (hit) {
            courseIdBySheet.set(`${sh.visibleOrderIndex}:${sh.title}`, hit.id);
            matchedCourseIds.add(hit.id);
          }
        }
        if (matchedCourseIds.size > 0) {
          const snapshotsMap = await loadLessonSnapshotsMapForCourses(
            supabase,
            [...matchedCourseIds],
            studentIdToName,
            onProgress
          );
          const now = new Date();
          for (const sh of scannedSheets) {
            const cid = courseIdBySheet.get(`${sh.visibleOrderIndex}:${sh.title}`);
            if (!cid) continue;
            const snaps = snapshotsMap.get(cid) ?? [];
            if (snaps.length > 0) {
              const diff = buildReimportDiffForSheet(sh, cid, snaps, now);
              const matched = courses.find((c) => c.id === cid);
              if (matched && !Boolean(matched.sync_completed)) {
                diff.pendingCompletionSync = true;
              }
              sh.reimportDiff = diff;
            }
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
      workbookTitle,
      workbookClassType: detectClassType(workbookTitle),
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
    teacherAliasResolutions?: TeacherAliasResolution[];
    /** When workbook title does not contain Online_DE / Online_VN / Offline, pass the user’s choice from Review Import. */
    workbookClassType?: unknown;
  }
): Promise<SyncGoogleSheetResult> {
  const onProgress = options?.onProgress;
  const skippedRowsBySheet = options?.skippedRowsBySheet ?? {};
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

    const classType = resolveClassTypeForSync(workbookTitle, options?.workbookClassType);
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
    const groupLookupId = loaded.groupSpreadsheetId ?? sourceKey;
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
    let anyCourseHadSkippedSessions = false;
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
        item.sheetUrl,
        { dedupeFolienRows },
        onProgress
      );
      if (result.ok) {
        synced++;
        if (result.hadSkippedSessions) anyCourseHadSkippedSessions = true;
        const { data: c } = await supabase
          .from('courses')
          .select('id')
          .eq('group_id', group.id)
          .eq('name', item.title)
          .maybeSingle();
        if (c?.id) importedCourseIds.push(c.id);
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

    const groupSyncCompleted =
      skippedAfterCurrentCourse === 0 && !anyCourseHadSkippedSessions && allImportedCoursesCompleted;
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
