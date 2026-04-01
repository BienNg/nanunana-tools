import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/** Map a sheet spelling to an existing student during import; persisted as `student_aliases`. */
export type StudentAliasResolution = { aliasName: string; studentId: string };

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
    if (!aliasName || !studentId) continue;
    out.push({ aliasName, studentId });
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
  for (const { aliasName, studentId } of resolutions) {
    if (!validStudentIds.has(studentId)) {
      throw new Error(`Unknown student for alias "${aliasName}"`);
    }
    const trimmed = String(aliasName).trim();
    const nk = studentCacheKey(trimmed);
    if (!nk) continue;
    await onProgress?.({
      type: 'db',
      message: `student_aliases — upsert "${trimmed}"`,
    });
    const { error } = await supabase.from('student_aliases').upsert(
      { group_id: groupId, student_id: studentId, alias: trimmed, normalized_key: nk },
      { onConflict: 'group_id,normalized_key' }
    );
    if (error) throw new Error(error.message);
    studentCache.set(nk, studentId);
  }
}

export function getStudentCacheKey(name: string | null | undefined): string {
  return studentCacheKey(name);
}
