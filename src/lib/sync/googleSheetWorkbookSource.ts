import { google, sheets_v4 } from 'googleapis';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { parseSpreadsheetIdFromUrl } from '@/lib/googleSheets/parseSpreadsheetIdFromUrl';

export type AttendanceFromColor = 'Present' | 'Absent' | null;
export type SheetRow = string[];

export type LoadedVisibleSheet = {
  title: string;
  rows: SheetRow[];
  colorAttendance: AttendanceFromColor[][];
  /** Per-tab Google Sheets URL (`…/edit#gid=…`); null when not available (e.g. .xlsx import). */
  sheetUrl: string | null;
};

export type LoadedWorkbook = {
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

export type SheetSyncSource = string | { fileName: string; bytes: Uint8Array };

export type SourceLoadProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number };

function canonicalGoogleSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function googleSheetTabUrl(spreadsheetId: string, sheetId: number): string {
  return `${canonicalGoogleSpreadsheetUrl(spreadsheetId)}#gid=${sheetId}`;
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

/** Green-dominant (any shade) -> present; red-dominant -> absent; white/gray/default -> no row. */
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

function toIsoDateFromGoogleSerial(serial: number): string {
  // Google Sheets date serial uses 1899-12-30 as day 0.
  const baseUtc = Date.UTC(1899, 11, 30);
  const wholeDays = Math.floor(serial);
  const dt = new Date(baseUtc + wholeDays * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateTextFromGoogleCell(cell: sheets_v4.Schema$CellData): string | null {
  const num = cell.effectiveValue?.numberValue;
  if (num == null || !Number.isFinite(num)) return null;
  const fmtType =
    cell.effectiveFormat?.numberFormat?.type ?? cell.userEnteredFormat?.numberFormat?.type ?? null;
  if (fmtType !== 'DATE' && fmtType !== 'DATE_TIME') return null;
  return toIsoDateFromGoogleSerial(num);
}

function cellStringFromCellData(cell: sheets_v4.Schema$CellData | undefined | null): string {
  if (!cell) return '';
  const dateText = dateTextFromGoogleCell(cell);
  if (dateText) return dateText;
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

async function loadWorkbookFromGoogleSheets(
  url: string,
  onProgress?: (event: SourceLoadProgressEvent) => void | Promise<void>
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
    const sheetUrl = typeof gid === 'number' ? googleSheetTabUrl(spreadsheetId, gid) : null;
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
  onProgress?: (event: SourceLoadProgressEvent) => void | Promise<void>
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
  onProgress?: (event: SourceLoadProgressEvent) => void | Promise<void>
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

type XlsxFetchAccessHint = 'google_sheet_export' | 'google_drive_download' | 'direct_url';

function messageForXlsxAccessDenied(hint: XlsxFetchAccessHint, status: number): string {
  if (hint === 'google_sheet_export') {
    return `Spreadsheet download failed (HTTP ${status}). Set Google Sheets sharing to “Anyone with the link” (Viewer) and try again.`;
  }
  if (hint === 'google_drive_download') {
    return `Could not download the file from Google Drive (HTTP ${status}). Share the file so “Anyone with the link” can view it (Share → General access), then try again.`;
  }
  return `Failed to download .xlsx file: HTTP ${status}. If this URL is on Google Drive or similar, share it so anyone with the link can view it without signing in.`;
}

async function fetchXlsxBytesFromUrl(
  url: string,
  accessHint: XlsxFetchAccessHint = 'direct_url'
): Promise<{ bytes: Uint8Array; fileName: string | null }> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(messageForXlsxAccessDenied(accessHint, response.status));
    }
    throw new Error(`Failed to download .xlsx file: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const fileName =
    fileNameFromContentDisposition(response.headers.get('content-disposition')) ?? fileNameFromUrl(response.url);
  return { bytes: new Uint8Array(arrayBuffer), fileName };
}

export async function loadWorkbookFromSource(
  source: SheetSyncSource,
  onProgress?: (event: SourceLoadProgressEvent) => void | Promise<void>
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
        const downloaded = await fetchXlsxBytesFromUrl(exportUrl, 'google_sheet_export');
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
      const downloaded = await fetchXlsxBytesFromUrl(directDownloadUrl, 'google_drive_download');
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
