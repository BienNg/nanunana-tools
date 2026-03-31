import { normalizePersonNameKey } from '@/lib/normalizePersonName';

/** Same splitting rules as sheet import (`googleSheetSync.parseTeacherNames`). */
export function parseTeacherNamesForLesson(raw: string | undefined | null): string[] {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (!s) return [];
  return s
    .split(/[/,;\n]+|\s+und\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Whether `lessons.teacher` (free-text, possibly multiple names) mentions this teacher,
 * using normalized keys (canonical name + every `teacher_aliases.normalized_key`).
 */
export function lessonMatchesAnyTeacherKey(lessonTeacher: unknown, matchKeys: ReadonlySet<string>): boolean {
  if (matchKeys.size === 0) return false;
  const names = parseTeacherNamesForLesson(typeof lessonTeacher === 'string' ? lessonTeacher : undefined);
  return names.some((n) => {
    const k = normalizePersonNameKey(n);
    return Boolean(k && matchKeys.has(k));
  });
}

export function buildTeacherLessonMatchKeys(
  canonicalName: string,
  aliasNormalizedKeys: readonly string[]
): Set<string> {
  const set = new Set<string>();
  const main = normalizePersonNameKey(canonicalName);
  if (main) set.add(main);
  for (const ak of aliasNormalizedKeys) {
    const t = String(ak ?? '').trim();
    if (t) set.add(t);
  }
  return set;
}
