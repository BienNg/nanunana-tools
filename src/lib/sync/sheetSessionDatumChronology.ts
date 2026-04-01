import { isSheetDatumStrictlyAfterToday, parseSheetDatum } from '@/lib/sync/currentCourseSheet';

/**
 * Session rows in teaching order: each parseable Datum must be strictly after the previous active
 * neighbor and strictly before the next (duplicates vs neighbors fail). Unparseable dates do not
 * produce chronology outliers.
 *
 * **Neighbors:** When walking for prev/next we skip skipped rows, trailing no-date/teacher rows,
 * rows above maxValidationRowIndex, and **future** dates — so a past lesson compares to adjacent
 * past lessons, not through a block of upcoming sessions.
 *
 * **Validation target:** A row is still checked for ordering if its Datum is in the future (e.g.
 * wrong month 20.11 between 19.01 and 22.01), using those same neighbor rules.
 */
export type DatumChronologyScope = {
  rowCount: number;
  getDatumRaw: (rowIndex: number) => string;
  skippedRows: ReadonlySet<number>;
  trailingNoDateTeacherRows: ReadonlySet<number>;
  maxValidationRowIndex: number | null;
  now: Date;
};

export type ReimportDiffChronologyRef =
  | {
      newSessionRowIndices: readonly number[];
      changedCellsByRow: Readonly<Record<number, readonly string[]>>;
    }
  | undefined;

/** Matches Review Import: full sheet unless re-importing, then only new rows or Datum changes. */
export function datumChronoAppliesToRow(d: ReimportDiffChronologyRef, rowIdx: number): boolean {
  if (!d) return true;
  if (d.newSessionRowIndices.includes(rowIdx)) return true;
  return (d.changedCellsByRow[rowIdx] ?? []).includes('Datum');
}

/** Skipped / trailing / above max-validation row; does not include “future” Datum. */
export function rowOutsideChronologyValidationTarget(scope: DatumChronologyScope, rowIndex: number): boolean {
  if (rowIndex < 0 || rowIndex >= scope.rowCount) return true;
  if (scope.skippedRows.has(rowIndex)) return true;
  if (scope.trailingNoDateTeacherRows.has(rowIndex)) return true;
  if (scope.maxValidationRowIndex !== null && rowIndex > scope.maxValidationRowIndex) return true;
  return false;
}

/**
 * Rows ignored when linking prev/next for chronology (includes future Datum so past rows “see”
 * across planned sessions).
 */
function rowOutsideChronologyNeighborChain(scope: DatumChronologyScope, rowIndex: number): boolean {
  if (rowOutsideChronologyValidationTarget(scope, rowIndex)) return true;
  return isSheetDatumStrictlyAfterToday(scope.getDatumRaw(rowIndex), scope.now);
}

/** Review Import “outside validation” for non-chrono rules (empty cells, etc.): includes future. */
export function rowOutsideDatumChronologyScope(scope: DatumChronologyScope, rowIndex: number): boolean {
  if (rowOutsideChronologyValidationTarget(scope, rowIndex)) return true;
  return isSheetDatumStrictlyAfterToday(scope.getDatumRaw(rowIndex), scope.now);
}

function previousActiveDatumRowIndex(scope: DatumChronologyScope, rowIndex: number): number {
  for (let i = rowIndex - 1; i >= 0; i--) {
    if (rowOutsideChronologyNeighborChain(scope, i)) continue;
    return i;
  }
  return -1;
}

function nextActiveDatumRowIndex(scope: DatumChronologyScope, rowIndex: number): number {
  for (let i = rowIndex + 1; i < scope.rowCount; i++) {
    if (rowOutsideChronologyNeighborChain(scope, i)) continue;
    return i;
  }
  return -1;
}

export function isDatumChronologyOutlier(scope: DatumChronologyScope, rowIndex: number): boolean {
  if (rowOutsideChronologyValidationTarget(scope, rowIndex)) return false;
  if (scope.rowCount < 2) return false;

  const cur = parseSheetDatum(scope.getDatumRaw(rowIndex));
  if (cur === null) return false;

  const prevIdx = previousActiveDatumRowIndex(scope, rowIndex);
  const nextIdx = nextActiveDatumRowIndex(scope, rowIndex);
  const prev = prevIdx >= 0 ? parseSheetDatum(scope.getDatumRaw(prevIdx)) : null;
  const next = nextIdx >= 0 ? parseSheetDatum(scope.getDatumRaw(nextIdx)) : null;

  if (prevIdx < 0) {
    if (next === null) return false;
    return cur >= next;
  }

  if (nextIdx < 0) {
    if (prev === null) return false;
    return cur <= prev;
  }

  if (prev !== null && next !== null) {
    return cur <= prev || cur >= next;
  }

  if (prev !== null && next === null) return cur <= prev;
  if (prev === null && next !== null) return cur >= next;

  return false;
}
