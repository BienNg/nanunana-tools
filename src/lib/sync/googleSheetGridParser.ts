import type { AttendanceFromColor, SheetRow } from '@/lib/sync/googleSheetWorkbookSource';

export type ScannedStudent = { name: string; letters: string[] };

/** One preview row: core columns in `values`, per-student cell color attendance (matches DB import). */
export type ScannedSampleRow = {
  values: Record<string, string>;
  studentAttendance: Record<string, 'Present' | 'Absent' | null>;
};

/** One logical student per trimmed name; duplicate header columns share indices for attendance merge. */
type SheetStudentColumn = { indices: number[]; name: string };

function parseTeacherNames(raw: string | undefined | null): string[] {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (!s) return [];
  return s
    .split(/[/,;\n]+|\s+und\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function findHeaderRowIndex(rows: SheetRow[]): number {
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

export function findCoreColumnIndices(headers: SheetRow): {
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

export function lehrerColumnIndices(headers: SheetRow): number[] {
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
export function isNonStudentColumnHeader(raw: string): boolean {
  const t = String(raw).trim().toLowerCase();
  if (!t) return true;
  if (t.includes('nachricht')) return true;
  if (t.includes('bemerkung')) return true;
  if (t.includes('notiz')) return true;
  if (t.includes('kommentar')) return true;
  return false;
}

export function dedupeSheetStudentColumns(studentNames: { index: number; name: string }[]): SheetStudentColumn[] {
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

export function pickFirstAttendanceStatus(
  attRow: AttendanceFromColor[] | undefined,
  indices: number[]
): AttendanceFromColor {
  for (const i of indices) {
    const s = attRow?.[i] ?? null;
    if (s !== null) return s;
  }
  return null;
}

export function mergedFeedbackFromRow(row: SheetRow, indices: number[]): string {
  const parts: string[] = [];
  for (const i of indices) {
    const cell = row[i];
    const t = cell ? String(cell).trim() : '';
    if (t) parts.push(t);
  }
  return parts.join(' ').trim();
}

export function normalizeFolienKey(value: string | undefined | null): string {
  return String(value ?? '').trim().toLowerCase();
}

export function columnIndexToA1Letter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Parse grid into preview rows + optional full scanned sheet (null when the tab is not a course layout).
 * Used by scan and sync so current-course detection matches import.
 */
export function processVisibleSheetGrid(
  title: string,
  rows: SheetRow[] | undefined | null,
  colorAttendance: AttendanceFromColor[][] | undefined | null,
  options?: { dedupeFolienRows?: boolean }
): {
  sampleRows: ScannedSampleRow[];
  scanned: {
    title: string;
    headers: {
      folien?: string;
      datum?: string;
      von?: string;
      bis?: string;
      lehrer: string[];
      students: ScannedStudent[];
    };
    sampleRows: ScannedSampleRow[];
  } | null;
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
      rowValues[col.name] = mergedFeedbackFromRow(row, col.indices);
      studentAttendance[col.name] = pickFirstAttendanceStatus(attRow, col.indices);
    }

    const rowHasAnyContent = Object.values(rowValues).some((v) => String(v).trim() !== '');
    if (!rowHasAnyContent) continue;

    sampleRows.push({ values: rowValues, studentAttendance });
  }

  const scanned = {
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
