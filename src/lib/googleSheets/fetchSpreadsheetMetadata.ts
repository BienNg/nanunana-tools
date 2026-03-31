import { google } from 'googleapis';
import ExcelJS from 'exceljs';
import { parseSpreadsheetIdFromUrl } from '@/lib/googleSheets/parseSpreadsheetIdFromUrl';

export type SpreadsheetVisibleTab = { title: string; sheetId: number };

export type FetchedSpreadsheetMetadata = {
  spreadsheetId: string;
  workbookTitle: string;
  visibleTabs: SpreadsheetVisibleTab[];
  /**
   * False when metadata came from an XLSX export because the Sheets API could not read the file
   * (e.g. Excel-in-Sheets). Real `#gid=` links require the API.
   */
  tabIdsFromApi: boolean;
  /** Human-readable note when tabIdsFromApi is false (for support / UI copy). */
  provenViaExport?: string;
};

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
    throw new Error(`Failed to download exported spreadsheet: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const fileName =
    fileNameFromContentDisposition(response.headers.get('content-disposition')) ?? fileNameFromUrl(response.url);
  return { bytes: new Uint8Array(arrayBuffer), fileName };
}

function errorMessageFromUnknown(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  const err = e as { response?: { data?: { error?: { message?: string; errors?: { message?: string }[] } } } };
  const apiMsg =
    err?.response?.data?.error?.message ??
    err?.response?.data?.error?.errors?.[0]?.message;
  if (typeof apiMsg === 'string' && apiMsg.trim()) return apiMsg.trim();
  return 'Failed to load spreadsheet.';
}

async function loadTabTitlesFromXlsxExport(
  spreadsheetId: string,
  apiErrorMessage: string
): Promise<FetchedSpreadsheetMetadata> {
  const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
  const downloaded = await fetchXlsxBytesFromUrl(exportUrl);
  const workbook = new ExcelJS.Workbook();
  const xlsxInput = Buffer.from(downloaded.bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(xlsxInput);

  const workbookTitle =
    (downloaded.fileName?.replace(/\.xlsx$/i, '').trim() ?? '') ||
    'Imported workbook';

  const visibleWorksheets = workbook.worksheets.filter(
    (ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden'
  );
  const visibleTabs: SpreadsheetVisibleTab[] = visibleWorksheets.map((ws, index) => ({
    title: ws.name.trim(),
    sheetId: index,
  }));

  return {
    spreadsheetId,
    workbookTitle,
    visibleTabs,
    tabIdsFromApi: false,
    provenViaExport: `Sheets API error was: "${apiErrorMessage}". Metadata was read from an .xlsx export instead (tab links are not available until the file is a native Google Sheet).`,
  };
}

export async function fetchSpreadsheetMetadata(inputUrl: string): Promise<FetchedSpreadsheetMetadata> {
  const spreadsheetId = parseSpreadsheetIdFromUrl(inputUrl.trim());
  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheets URL (could not find spreadsheet id).');
  }

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not configured in the environment.');
  }

  const sheetsApi = google.sheets({
    version: 'v4',
    auth: process.env.GOOGLE_API_KEY,
  });

  try {
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const workbookTitle = spreadsheet.data.properties?.title?.trim() ?? '';

    const visibleTabs: SpreadsheetVisibleTab[] = [];
    for (const s of spreadsheet.data.sheets ?? []) {
      const title = s.properties?.title;
      if (!title || s.properties?.hidden) continue;
      const sheetId = s.properties?.sheetId;
      if (typeof sheetId !== 'number') continue;
      visibleTabs.push({ title: title.trim(), sheetId });
    }

    return {
      spreadsheetId,
      workbookTitle,
      visibleTabs,
      tabIdsFromApi: true,
    };
  } catch (apiErr) {
    const apiMsg = errorMessageFromUnknown(apiErr);
    try {
      return await loadTabTitlesFromXlsxExport(spreadsheetId, apiMsg);
    } catch {
      const hint =
        /not supported|cannot be read|invalid/i.test(apiMsg)
          ? ' Google often returns this for Excel files opened in Sheets without converting to a native Google Sheet (File → Save as Google Sheets).'
          : '';
      throw new Error(`${apiMsg}${hint}`);
    }
  }
}
