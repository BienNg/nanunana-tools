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

/**
 * Among visible tabs in workbook order: sheet whose first session date is on or before `now`,
 * and whose latest row with both date and teacher filled has the greatest session date.
 * Ties use the earlier tab. Returns null if no tab qualifies.
 */
export function findCurrentCourseVisibleIndex(slots: CurrentCourseSlot[], now: Date): number | null {
  const todayTs = localDayTimestamp(now.getFullYear(), now.getMonth(), now.getDate());
  if (todayTs === null) return null;

  let bestIdx: number | null = null;
  let bestLatestTs = -Infinity;

  slots.forEach((slot, idx) => {
    const rows = slot.sampleRows;
    if (rows.length === 0) return;

    const firstTs = parseSheetDatum(rows[0].values['Datum'] ?? '');
    if (firstTs === null || firstTs > todayTs) return;

    let latestTs: number | null = null;
    for (const row of rows) {
      const dt = parseSheetDatum(row.values['Datum'] ?? '');
      if (dt === null || isEmptyCellValue(row.values['Lehrer'])) continue;
      if (latestTs === null || dt > latestTs) latestTs = dt;
    }
    if (latestTs === null) return;

    if (latestTs > bestLatestTs || (latestTs === bestLatestTs && bestIdx !== null && idx < bestIdx)) {
      bestLatestTs = latestTs;
      bestIdx = idx;
    }
  });

  return bestIdx;
}
