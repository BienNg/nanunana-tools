import { isSheetDatumOnOrBeforeToday, parseSheetDatum } from '@/lib/sync/currentCourseSheet';
import {
  datumChronoAppliesToRow,
  isDatumChronologyOutlier,
  rowOutsideChronologyValidationTarget,
  rowOutsideDatumChronologyScope,
  type DatumChronologyScope,
} from '@/lib/sync/sheetSessionDatumChronology';
import type { ScannedSampleRow, ScannedSheet } from '@/lib/sync/googleSheetSync';

const DATA_COLUMN_KEYS = ['Folien', 'Datum', 'von', 'bis', 'Lehrer'] as const;

export function normalizeDisplayCellText(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return '';
  if (s === '[object Object]') return '';
  return s;
}

export function isEmptyCellValue(v: unknown): boolean {
  return normalizeDisplayCellText(v).length === 0;
}

export function sampleRowsDatumChronologyScope(
  rows: ScannedSampleRow[],
  skippedRows: ReadonlySet<number>,
  trailingNoDateTeacherRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): DatumChronologyScope {
  return {
    rowCount: rows.length,
    getDatumRaw: (i) => String(rows[i]?.values['Datum'] ?? ''),
    skippedRows,
    trailingNoDateTeacherRows,
    maxValidationRowIndex,
    now,
  };
}

export function rowOutsideValidationScope(
  rows: ScannedSampleRow[],
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  trailingNoDateTeacherRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): boolean {
  return rowOutsideDatumChronologyScope(
    sampleRowsDatumChronologyScope(rows, skippedRows, trailingNoDateTeacherRows, maxValidationRowIndex, now),
    rowIndex
  );
}

/** Sheet color attendance (Present / Absent) or explicit absent wording counts as attendance data. */
export function studentCellHasAttendanceData(row: ScannedSampleRow, studentName: string): boolean {
  const a = row.studentAttendance[studentName];
  if (a === 'Present' || a === 'Absent') return true;
  const t = String(row.values[studentName] ?? '').trim();
  return /\babwesend\b/i.test(t) || /\babsent\b/i.test(t);
}

/** Row index of first cell with text or color attendance, or -1 if they never appear. */
export function studentFirstAttendanceRowIndex(
  rows: ScannedSampleRow[],
  studentName: string,
  skippedRows: ReadonlySet<number>,
  trailingNoDateTeacherRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): number {
  const end = maxValidationRowIndex === null ? rows.length - 1 : Math.min(rows.length - 1, maxValidationRowIndex);
  for (let r = 0; r <= end; r++) {
    if (rowOutsideValidationScope(rows, r, skippedRows, trailingNoDateTeacherRows, maxValidationRowIndex, now)) continue;
    if (studentCellHasAttendanceData(rows[r], studentName)) return r;
  }
  return -1;
}

/** Empty student cells before first attendance are allowed (not joined yet). */
export function isStudentEmptyViolation(
  rows: ScannedSampleRow[],
  rowIndex: number,
  studentName: string,
  skippedRows: ReadonlySet<number>,
  trailingNoDateTeacherRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): boolean {
  if (rowOutsideValidationScope(rows, rowIndex, skippedRows, trailingNoDateTeacherRows, maxValidationRowIndex, now))
    return false;
  const first = studentFirstAttendanceRowIndex(
    rows,
    studentName,
    skippedRows,
    trailingNoDateTeacherRows,
    maxValidationRowIndex,
    now
  );
  if (first < 0) return false;
  return rowIndex > first && !studentCellHasAttendanceData(rows[rowIndex], studentName);
}

export function trailingNoDateTeacherSessionRows(rows: ScannedSampleRow[]): ReadonlySet<number> {
  const out = new Set<number>();
  let allFollowingNoDateTeacher = true;
  for (let i = rows.length - 1; i >= 0; i--) {
    const noDate = isEmptyCellValue(rows[i]?.values['Datum']);
    const noTeacher = isEmptyCellValue(rows[i]?.values['Lehrer']);
    const isNoDateTeacher = noDate && noTeacher;
    if (allFollowingNoDateTeacher && isNoDateTeacher) {
      out.add(i);
    } else {
      allFollowingNoDateTeacher = false;
    }
  }
  return out;
}

/** When re-importing an existing tab, only count validation for new sessions or cells that will change. */
export function validationInReimportScope(sheet: ScannedSheet, rowIdx: number, columnKey: string): boolean {
  const d = sheet.reimportDiff;
  if (!d) return true;
  if (d.newSessionRowIndices.includes(rowIdx)) return true;
  return (d.changedCellsByRow[rowIdx] ?? []).includes(columnKey);
}

export function datumChronoInReimportScope(sheet: ScannedSheet, rowIdx: number): boolean {
  return datumChronoAppliesToRow(sheet.reimportDiff, rowIdx);
}

export function countSheetValidationIssues(
  sheet: ScannedSheet,
  skippedRows: ReadonlySet<number>,
  skippedAttendanceCells: ReadonlySet<string>,
  trailingNoDateTeacherRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): number {
  const { sampleRows } = sheet;
  const chronoScope = sampleRowsDatumChronologyScope(
    sampleRows,
    skippedRows,
    trailingNoDateTeacherRows,
    maxValidationRowIndex,
    now
  );
  let n = 0;
  sampleRows.forEach((row, rIdx) => {
    const outsideFull = rowOutsideValidationScope(
      sampleRows,
      rIdx,
      skippedRows,
      trailingNoDateTeacherRows,
      maxValidationRowIndex,
      now
    );
    if (!outsideFull) {
      for (const key of DATA_COLUMN_KEYS) {
        if (!validationInReimportScope(sheet, rIdx, key)) continue;
        if (key === 'Lehrer') {
          if (
            isEmptyCellValue(row.values['Lehrer']) &&
            isSheetDatumOnOrBeforeToday(row.values['Datum'] ?? '', now)
          ) {
            n++;
          }
          continue;
        }
        if (isEmptyCellValue(row.values[key])) n++;
      }
      if (
        !isEmptyCellValue(row.values['Datum']) &&
        parseSheetDatum(row.values['Datum'] ?? '') === null &&
        validationInReimportScope(sheet, rIdx, 'Datum')
      ) {
        n++;
      }
    }
    if (
      !rowOutsideChronologyValidationTarget(chronoScope, rIdx) &&
      !isEmptyCellValue(row.values['Datum']) &&
      datumChronoInReimportScope(sheet, rIdx) &&
      isDatumChronologyOutlier(chronoScope, rIdx)
    ) {
      n++;
    }
    if (!outsideFull) {
      for (const s of sheet.headers.students) {
        if (!validationInReimportScope(sheet, rIdx, s.name)) continue;
        if (skippedAttendanceCells.has(`${rIdx}:${s.name}`)) continue;
        if (
          isStudentEmptyViolation(
            sampleRows,
            rIdx,
            s.name,
            skippedRows,
            trailingNoDateTeacherRows,
            maxValidationRowIndex,
            now
          )
        ) {
          n++;
        }
      }
    }
  });
  return n;
}

/**
 * For first-time Review Import (no reimport diff): exclude rows the preview would not treat as import-ready.
 * Rows outside the validation window are not imported; rows with any blocking issue are not imported.
 */
export function newSheetRowExcludedFromImport(
  sheet: ScannedSheet,
  rowIndex: number,
  skippedRows: ReadonlySet<number>,
  skippedAttendanceCells: ReadonlySet<string>,
  trailingNoDateTeacherRows: ReadonlySet<number>,
  maxValidationRowIndex: number | null,
  now: Date
): boolean {
  if (sheet.reimportDiff) return false;

  const { sampleRows } = sheet;
  const row = sampleRows[rowIndex];
  if (!row) return true;

  const chronoScope = sampleRowsDatumChronologyScope(
    sampleRows,
    skippedRows,
    trailingNoDateTeacherRows,
    maxValidationRowIndex,
    now
  );

  const outsideFull = rowOutsideValidationScope(
    sampleRows,
    rowIndex,
    skippedRows,
    trailingNoDateTeacherRows,
    maxValidationRowIndex,
    now
  );
  if (outsideFull) return true;

  for (const key of DATA_COLUMN_KEYS) {
    if (key === 'Lehrer') {
      if (
        isEmptyCellValue(row.values['Lehrer']) &&
        isSheetDatumOnOrBeforeToday(row.values['Datum'] ?? '', now)
      ) {
        return true;
      }
      continue;
    }
    if (isEmptyCellValue(row.values[key])) return true;
  }

  if (!isEmptyCellValue(row.values['Datum']) && parseSheetDatum(row.values['Datum'] ?? '') === null) {
    return true;
  }

  if (
    !rowOutsideChronologyValidationTarget(chronoScope, rowIndex) &&
    !isEmptyCellValue(row.values['Datum']) &&
    isDatumChronologyOutlier(chronoScope, rowIndex)
  ) {
    return true;
  }

  for (const s of sheet.headers.students) {
    if (skippedAttendanceCells.has(`${rowIndex}:${s.name}`)) continue;
    if (
      isStudentEmptyViolation(
        sampleRows,
        rowIndex,
        s.name,
        skippedRows,
        trailingNoDateTeacherRows,
        maxValidationRowIndex,
        now
      )
    ) {
      return true;
    }
  }

  return false;
}

/** Pending re-import structural updates after row skips (new rows or changed core cells). */
export function sheetHasRemainingStructuralDiff(
  sheet: ScannedSheet,
  skippedRows: ReadonlySet<number>
): boolean {
  const d = sheet.reimportDiff;
  if (!d) return false;
  for (const idx of d.newSessionRowIndices) {
    if (!skippedRows.has(idx)) return true;
  }
  for (const rowIdxStr of Object.keys(d.changedCellsByRow)) {
    const rowIdx = Number(rowIdxStr);
    if (!Number.isFinite(rowIdx) || skippedRows.has(rowIdx)) continue;
    const cells = d.changedCellsByRow[rowIdx];
    if (cells && cells.length > 0) return true;
  }
  return false;
}
