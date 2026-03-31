/** Extract spreadsheet id from a Google Sheets edit/share URL. */
export function parseSpreadsheetIdFromUrl(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? null;
}
