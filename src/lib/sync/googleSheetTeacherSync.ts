import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';

/** Map a sheet spelling to an existing teacher during import; persisted as `teacher_aliases`. */
export type TeacherAliasResolution = { aliasName: string; teacherId: string };

type SyncProgressEventLike =
  | { type: 'status'; message: string }
  | { type: 'sheet'; title: string; current: number; total: number }
  | { type: 'db'; message: string };

export function parseTeacherAliasResolutions(raw: unknown): TeacherAliasResolution[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  const out: TeacherAliasResolution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const aliasName = typeof o.aliasName === 'string' ? o.aliasName.trim() : '';
    const teacherId = typeof o.teacherId === 'string' ? o.teacherId.trim() : '';
    if (!aliasName || !teacherId) continue;
    out.push({ aliasName, teacherId });
  }
  return out.length ? out : undefined;
}

export async function loadTeacherResolutionData(
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<{
  teacherCache: Map<string, string>;
  existingTeachersForPicker: { id: string; name: string }[];
  validTeacherIds: Set<string>;
  /** Canonical `teachers.name` for display on imported lessons (id -> name). */
  canonicalTeacherNameById: Map<string, string>;
}> {
  const { data: allTeachers, error: teachersError } = await supabase.from('teachers').select('id, name');
  if (teachersError) throw new Error(teachersError.message);

  const canonicalTeacherNameById = new Map<string, string>();
  const teacherCache = new Map<string, string>();
  for (const t of allTeachers ?? []) {
    canonicalTeacherNameById.set(t.id, t.name);
    const key = normalizePersonNameKey(t.name);
    if (key) teacherCache.set(key, t.id);
  }

  const { data: aliasRows, error: aliasesError } = await supabase
    .from('teacher_aliases')
    .select('teacher_id, normalized_key');
  if (aliasesError) throw new Error(aliasesError.message);

  for (const row of aliasRows ?? []) {
    const nk = String(row.normalized_key ?? '').trim();
    const tid = row.teacher_id as string | undefined;
    if (!nk || !tid) continue;
    const existing = teacherCache.get(nk);
    if (existing && existing !== tid) {
      console.warn(
        `[sync] teacher_aliases normalized_key "${nk}" maps to ${tid} but cache already had ${existing}; skipping alias row`
      );
      continue;
    }
    teacherCache.set(nk, tid);
  }

  const existingTeachersForPicker = [...(allTeachers ?? [])]
    .map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const validTeacherIds = new Set((allTeachers ?? []).map((t: { id: string }) => t.id));

  return { teacherCache, existingTeachersForPicker, validTeacherIds, canonicalTeacherNameById };
}

export async function applyTeacherAliasResolutions(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  teacherCache: Map<string, string>,
  resolutions: TeacherAliasResolution[] | undefined,
  validTeacherIds: Set<string>,
  onProgress?: (event: SyncProgressEventLike) => void | Promise<void>
) {
  if (!resolutions?.length) return;
  for (const { aliasName, teacherId } of resolutions) {
    if (!validTeacherIds.has(teacherId)) {
      throw new Error(`Unknown teacher for alias "${aliasName}"`);
    }
    const trimmed = String(aliasName).trim();
    const nk = normalizePersonNameKey(trimmed);
    if (!nk) continue;
    await onProgress?.({
      type: 'db',
      message: `teacher_aliases — upsert "${trimmed}"`,
    });
    const { error } = await supabase.from('teacher_aliases').upsert(
      { teacher_id: teacherId, alias: trimmed, normalized_key: nk },
      { onConflict: 'normalized_key' }
    );
    if (error) throw new Error(error.message);
    teacherCache.set(nk, teacherId);
  }
}

/**
 * Sync teachers for one course using an in-memory cache to avoid per-row DB calls.
 *
 * @param teacherCache  normalized-name key -> id for every teacher already in the DB (mutated in place when new teachers are inserted)
 */
export async function syncCourseTeachers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  courseId: string,
  teacherNames: Set<string>,
  teacherCache: Map<string, string>,
  canonicalTeacherNameById: Map<string, string>,
  sheetLabel: string,
  onProgress?: (event: SyncProgressEventLike) => void | Promise<void>
) {
  const namesByKey = new Map<string, string>();
  for (const name of teacherNames) {
    const key = normalizePersonNameKey(name);
    if (!key || namesByKey.has(key)) continue;
    namesByKey.set(key, name);
  }
  const names = [...namesByKey.values()];

  const newNames = names.filter((n) => !teacherCache.has(normalizePersonNameKey(n)));

  if (newNames.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} teachers — insert ${newNames.length} new row(s)`,
    });
    const { data: inserted } = await supabase
      .from('teachers')
      .insert(newNames.map((name) => ({ name })))
      .select('id, name');

    (inserted ?? []).forEach((t: { id: string; name: string }) => {
      const key = normalizePersonNameKey(t.name);
      if (!key) return;
      teacherCache.set(key, t.id);
      canonicalTeacherNameById.set(t.id, t.name);
    });
  }

  const desiredTeacherIds = new Set<string>();
  for (const n of names) {
    const tid = teacherCache.get(normalizePersonNameKey(n));
    if (tid) desiredTeacherIds.add(tid);
  }

  const { data: existingLinks, error: linkSelErr } = await supabase
    .from('course_teachers')
    .select('teacher_id')
    .eq('course_id', courseId);
  if (linkSelErr) throw new Error(linkSelErr.message);
  const existingIds = new Set((existingLinks ?? []).map((r) => r.teacher_id as string));

  const toRemove = [...existingIds].filter((id) => !desiredTeacherIds.has(id));
  const toAdd = [...desiredTeacherIds].filter((id) => !existingIds.has(id));

  if (toRemove.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_teachers — remove ${toRemove.length} link(s)`,
    });
    await supabase.from('course_teachers').delete().eq('course_id', courseId).in('teacher_id', toRemove);
  }
  if (toAdd.length > 0) {
    await onProgress?.({
      type: 'db',
      message: `${sheetLabel} course_teachers — add ${toAdd.length} link(s)`,
    });
    await supabase
      .from('course_teachers')
      .insert(toAdd.map((teacher_id) => ({ course_id: courseId, teacher_id })));
  }
}
