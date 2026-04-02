function isEmptyCellValue(v: unknown): boolean {
  return String(v ?? '').trim().length === 0;
}

function normalizeTwoDigitYear(y: number): number {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

/** Local calendar day; returns noon timestamp for stable ordering, or null if invalid. */
function localDayTimestamp(y: number, month0: number, day: number): number | null {
  const dt = new Date(y, month0, day);
  if (dt.getFullYear() !== y || dt.getMonth() !== month0 || dt.getDate() !== day) return null;
  return new Date(y, month0, day, 12, 0, 0, 0).getTime();
}

/**
 * Parse sheet "Datum" cells (German dd.MM.yyyy common; also ISO / slash DMY).
 * Returns a comparable local-day timestamp, or null if empty or not parseable.
 */
export function parseSheetDatum(raw: string): number | null {
  const s = String(raw).trim();
  if (!s) return null;

  const head = (s.split(/\s|T/, 1)[0] ?? '').trim();

  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(head);
  if (de) {
    const d = parseInt(de[1], 10);
    const m = parseInt(de[2], 10);
    const y = normalizeTwoDigitYear(parseInt(de[3], 10));
    return localDayTimestamp(y, m - 1, d);
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(head);
  if (slash) {
    const d = parseInt(slash[1], 10);
    const m = parseInt(slash[2], 10);
    const y = normalizeTwoDigitYear(parseInt(slash[3], 10));
    return localDayTimestamp(y, m - 1, d);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    return localDayTimestamp(y, m - 1, d);
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    return localDayTimestamp(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  return null;
}

/** One tab’s lesson rows in workbook order (matches scan / sync grid parsing). */
export type CurrentCourseSlot = {
  sampleRows: { values: Record<string, string> }[];
};

/** True if the tab has at least one lesson row with a parseable Datum on or before `todayTs`. */
function slotHasAnyNonFutureDatum(slot: CurrentCourseSlot, todayTs: number): boolean {
  for (const row of slot.sampleRows) {
    const dt = parseSheetDatum(row.values['Datum'] ?? '');
    if (dt !== null && dt <= todayTs) return true;
  }
  return false;
}

/**
 * Visible tabs are courses in workbook order. Start at index 0; while the **next** tab has any
 * session with a parseable Datum on or before `now`, advance. The current course is that index,
 * unless no tab has such a Datum (then null). Teacher column is not required for this check.
 */
export function findCurrentCourseVisibleIndex(slots: CurrentCourseSlot[], now: Date): number | null {
  const todayTs = localDayTimestamp(now.getFullYear(), now.getMonth(), now.getDate());
  if (todayTs === null || slots.length === 0) return null;

  let current = 0;
  while (current + 1 < slots.length && slotHasAnyNonFutureDatum(slots[current + 1]!, todayTs)) {
    current++;
  }

  if (!slotHasAnyNonFutureDatum(slots[current]!, todayTs)) return null;
  return current;
}

/**
 * In one course tab, returns the last row index whose Datum parses to on or before local today.
 * Teacher is not required: a scheduled-today row without Lehrer must still fall inside Review Import’s
 * validation window so missing teacher can be flagged.
 * Returns null when no row qualifies (e.g. all sessions are in the future).
 */
export function findLastTaughtSessionRowIndex(
  rows: { values: Record<string, string> }[],
  now: Date
): number | null {
  const todayTs = localDayTimestamp(now.getFullYear(), now.getMonth(), now.getDate());
  if (todayTs === null) return null;

  let lastIdx: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const dt = parseSheetDatum(rows[i].values['Datum'] ?? '');
    if (dt === null || dt > todayTs) continue;
    lastIdx = i;
  }
  return lastIdx;
}

/** Local calendar “today” at noon, for comparisons with {@link parseSheetDatum}. */
export function localCalendarTodayTimestamp(now: Date): number | null {
  return localDayTimestamp(now.getFullYear(), now.getMonth(), now.getDate());
}

/** True when Datum parses to a calendar day strictly after local today (scheduled / not yet held). */
export function isSheetDatumStrictlyAfterToday(datumRaw: string | undefined | null, now: Date): boolean {
  const dt = parseSheetDatum(String(datumRaw ?? ''));
  if (dt === null) return false;
  const todayTs = localCalendarTodayTimestamp(now);
  if (todayTs === null) return false;
  return dt > todayTs;
}

/** True when Datum parses to a calendar day on or before local today (held or due). */
export function isSheetDatumOnOrBeforeToday(datumRaw: string | undefined | null, now: Date): boolean {
  const dt = parseSheetDatum(String(datumRaw ?? ''));
  if (dt === null) return false;
  const todayTs = localCalendarTodayTimestamp(now);
  if (todayTs === null) return false;
  return dt <= todayTs;
}

/**
 * `parseSheetDate` / DB-style `YYYY-MM-DD` strictly after local today.
 * Keeps import skips aligned with preview validation (same calendar rules).
 */
export function isIsoDateStrictlyAfterLocalToday(isoDate: string, now: Date): boolean {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!iso) return false;
  const y = parseInt(iso[1], 10);
  const m = parseInt(iso[2], 10);
  const d = parseInt(iso[3], 10);
  const dayTs = localDayTimestamp(y, m - 1, d);
  const todayTs = localCalendarTodayTimestamp(now);
  if (dayTs === null || todayTs === null) return false;
  return dayTs > todayTs;
}
