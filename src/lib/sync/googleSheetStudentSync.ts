import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  mergeStudentsByNameLength,
  rewriteStudentIdMappings,
  StudentMergeError,
  type TieWinnerChoice,
} from '@/lib/students/studentMerge';

/** Map a sheet spelling to an existing student during import; persisted as `student_aliases`. */
export type StudentAliasResolution = {
  aliasName: string;
  studentId: string;
  /** Required when alias maps two same-length canonical names and winner cannot be inferred. */
  tieWinnerStudentId?: string;
};

type SyncProgressEventLike =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number }
  | { type: 'db'; message: string };

function studentCacheKey(name: string | null | undefined): string {
  return normalizePersonNameKey(String(name ?? '').trim());
}

export function parseStudentAliasResolutions(raw: unknown): StudentAliasResolution[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  const out: StudentAliasResolution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const aliasName = typeof o.aliasName === 'string' ? o.aliasName.trim() : '';
    const studentId = typeof o.studentId === 'string' ? o.studentId.trim() : '';
    const tieWinnerStudentId =
      typeof o.tieWinnerStudentId === 'string' ? o.tieWinnerStudentId.trim() : '';
    if (!aliasName || !studentId) continue;
    out.push({
      aliasName,
      studentId,
      ...(tieWinnerStudentId ? { tieWinnerStudentId } : {}),
    });
  }
  return out.length ? out : undefined;
}

export async function loadStudentResolutionData(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  groupId: string
): Promise<{
  studentCache: Map<string, string>;
  existingStudentsForPicker: { id: string; name: string }[];
  validStudentIds: Set<string>;
}> {
  const { data: allStudents, error: studentsError } = await supabase
    .from('students')
    .select('id, name')
    .eq('group_id', groupId);
  if (studentsError) throw new Error(studentsError.message);

  const studentCache = new Map<string, string>();
  for (const s of allStudents ?? []) {
    const key = studentCacheKey(s.name);
    if (key) studentCache.set(key, s.id);
  }

  const { data: aliasRows, error: aliasesError } = await supabase
    .from('student_aliases')
    .select('student_id, normalized_key')
    .eq('group_id', groupId);
  if (aliasesError) throw new Error(aliasesError.message);

  for (const row of aliasRows ?? []) {
    const nk = String(row.normalized_key ?? '').trim();
    const sid = row.student_id as string | undefined;
    if (!nk || !sid) continue;
    const existing = studentCache.get(nk);
    if (existing && existing !== sid) {
      console.warn(
        `[sync] student_aliases key "${nk}" maps to ${sid} but cache already had ${existing}; skipping alias row`
      );
      continue;
    }
    studentCache.set(nk, sid);
  }

  const existingStudentsForPicker = [...(allStudents ?? [])]
    .map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const validStudentIds = new Set((allStudents ?? []).map((s: { id: string }) => s.id));
  return { studentCache, existingStudentsForPicker, validStudentIds };
}

export async function applyStudentAliasResolutions(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  groupId: string,
  studentCache: Map<string, string>,
  resolutions: StudentAliasResolution[] | undefined,
  validStudentIds: Set<string>,
  onProgress?: (event: SyncProgressEventLike) => void | Promise<void>
) {
  if (!resolutions?.length) return;
  const mergedInto = new Map<string, string>();
  const resolveStudentId = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    while (mergedInto.has(current) && !seen.has(current)) {
      seen.add(current);
      current = mergedInto.get(current) ?? current;
    }
    return current;
  };

  for (const resolution of resolutions) {
    const aliasName = resolution.aliasName;
    const requestedStudentId = resolveStudentId(resolution.studentId);
    const tieWinnerStudentId = resolution.tieWinnerStudentId
      ? resolveStudentId(resolution.tieWinnerStudentId)
      : undefined;

    if (!validStudentIds.has(requestedStudentId)) {
      throw new Error(`Unknown student for alias "${aliasName}"`);
    }
    const trimmed = String(aliasName).trim();
    const nk = studentCacheKey(trimmed);
    if (!nk) continue;

    const currentOwnerId = resolveStudentId(studentCache.get(nk) ?? '');
    let effectiveStudentId = requestedStudentId;
    if (currentOwnerId && currentOwnerId !== requestedStudentId) {
      const tieWinner: TieWinnerChoice | undefined = tieWinnerStudentId
        ? { winnerStudentId: tieWinnerStudentId }
        : undefined;
      await onProgress?.({
        type: 'db',
        message: `students — merge records for alias "${trimmed}"`,
      });
      try {
        const merged = await mergeStudentsByNameLength(supabase, {
          leftStudentId: currentOwnerId,
          rightStudentId: requestedStudentId,
          tieWinner,
          expectedGroupId: groupId,
        });
        mergedInto.set(merged.loserStudentId, merged.winnerStudentId);
        rewriteStudentIdMappings(
          studentCache,
          validStudentIds,
          merged.loserStudentId,
          merged.winnerStudentId
        );
        effectiveStudentId = merged.winnerStudentId;
      } catch (error) {
        if (error instanceof StudentMergeError && error.code === 'TIE_CHOICE_REQUIRED') {
          throw new Error(
            `Alias "${trimmed}" maps to two same-length student names. Provide tieWinnerStudentId in studentAliasResolutions.`
          );
        }
        throw error;
      }
    }

    if (!validStudentIds.has(effectiveStudentId)) {
      throw new Error(`Unknown student for alias "${aliasName}"`);
    }

    await onProgress?.({
      type: 'db',
      message: `student_aliases — upsert "${trimmed}"`,
    });
    const { error } = await supabase.from('student_aliases').upsert(
      { group_id: groupId, student_id: effectiveStudentId, alias: trimmed, normalized_key: nk },
      { onConflict: 'group_id,normalized_key' }
    );
    if (error) throw new Error(error.message);
    studentCache.set(nk, effectiveStudentId);
  }
}

export function getStudentCacheKey(name: string | null | undefined): string {
  return studentCacheKey(name);
}
