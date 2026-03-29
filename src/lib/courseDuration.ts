/**
 * Scheduled course duration from lesson rows + group class type.
 * Rules: Online_DE/VN → 1.5h per session; first session → 2h if actual span > 1h50m.
 * Offline → 2.5h per session. Unknown class type → sum of actual start/end times.
 */

export type GroupClassType = 'Online_DE' | 'Online_VN' | 'Offline';

export type LessonForDuration = {
  start_time?: string | null;
  end_time?: string | null;
};

/** Map DB `groups.class_type` to duration rules (trim + case-tolerant). */
export function normalizeGroupClassType(raw: string | null | undefined): GroupClassType | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === 'Online_DE' || t.toLowerCase() === 'online_de') return 'Online_DE';
  if (t === 'Online_VN' || t.toLowerCase() === 'online_vn') return 'Online_VN';
  if (t === 'Offline' || t.toLowerCase() === 'offline') return 'Offline';
  return null;
}

/** Positive minutes between schedule start/end (HH:MM or HH:MM:SS), or null if invalid. */
export function actualScheduleMinutes(
  start: string | null | undefined,
  end: string | null | undefined
): number | null {
  if (start == null || end == null || start === '' || end === '') return null;
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;
  if (endM <= startM) return null;
  return endM - startM;
}

/**
 * Minutes for one lesson index given class type. `lessons` must be in chronological order
 * (same order as sessions: first row = first session).
 */
export function lessonDurationMinutes(
  lesson: LessonForDuration,
  lessonIndex: number,
  classType: GroupClassType | null
): number {
  const isFirst = lessonIndex === 0;

  if (classType === 'Online_DE' || classType === 'Online_VN') {
    let sessionMinutes = 90;
    if (isFirst) {
      const actual = actualScheduleMinutes(lesson.start_time, lesson.end_time);
      if (actual != null && actual > 110) sessionMinutes = 120;
    }
    return sessionMinutes;
  }

  if (classType === 'Offline') {
    return 150;
  }

  return actualScheduleMinutes(lesson.start_time, lesson.end_time) ?? 0;
}

/** Total scheduled minutes for a course. Pass lessons ordered by date/time (first session first). */
export function totalCourseDurationMinutes(
  lessons: readonly LessonForDuration[],
  classType: GroupClassType | null
): number {
  let total = 0;
  for (let i = 0; i < lessons.length; i++) {
    total += lessonDurationMinutes(lessons[i]!, i, classType);
  }
  return total;
}

/** Display string like `29h 38m`. */
export function formatDurationHoursMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}
