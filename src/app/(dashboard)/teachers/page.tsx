import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  lessonDurationMinutes,
  normalizeGroupClassType,
  normalizeGroupDefaultLessonMinutes,
} from '@/lib/courseDuration';
import { buildTeacherLessonMatchKeys, lessonMatchesAnyTeacherKey } from '@/lib/teacherLessonMatch';
import TeachersClient from './TeachersClient';

export const dynamic = 'force-dynamic';

/** PostgREST often caps responses at 1000 rows; paginate so list totals match per-teacher pages. */
const ROW_PAGE = 1000;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function yearMonthFromLessonDate(dateStr: unknown): string | null {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

function extractClassType(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const first = value[0] as { class_type?: unknown } | undefined;
    return typeof first?.class_type === 'string' ? first.class_type : null;
  }
  if (typeof value === 'object') {
    const maybeObj = value as { class_type?: unknown };
    return typeof maybeObj.class_type === 'string' ? maybeObj.class_type : null;
  }
  return null;
}

function extractDefaultLessonMinutes(value: unknown): number | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const first = value[0] as { default_lesson_minutes?: unknown } | undefined;
    return normalizeGroupDefaultLessonMinutes(first?.default_lesson_minutes);
  }
  if (typeof value === 'object') {
    const maybeObj = value as { default_lesson_minutes?: unknown };
    return normalizeGroupDefaultLessonMinutes(maybeObj.default_lesson_minutes);
  }
  return null;
}

function hoursDisplayFromMinutes(minutes: number): string {
  const exactHours = minutes / 60;
  return (Math.trunc(exactHours * 100) / 100).toString();
}

type LessonRow = {
  id: string;
  course_id: string;
  date: string | null;
  start_time?: string | null;
  end_time?: string | null;
  teacher?: unknown;
  courses?: { groups?: unknown } | null;
};

async function fetchAllCourseTeacherRows(
  supabase: SupabaseClient,
  teacherIds: string[],
): Promise<{ teacher_id: string; course_id: string }[]> {
  if (teacherIds.length === 0) return [];
  const out: { teacher_id: string; course_id: string }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('course_teachers')
      .select('teacher_id, course_id')
      .in('teacher_id', teacherIds)
      .order('teacher_id', { ascending: true })
      .order('course_id', { ascending: true })
      .range(from, from + ROW_PAGE - 1);
    if (error) {
      console.error('Error fetching course_teachers (paged):', error);
      break;
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < ROW_PAGE) break;
    from += ROW_PAGE;
  }
  return out;
}

async function fetchAllTeacherAliasRows(
  supabase: SupabaseClient,
  teacherIds: string[],
): Promise<{ teacher_id: string; normalized_key: string | null }[]> {
  if (teacherIds.length === 0) return [];
  const out: { teacher_id: string; normalized_key: string | null }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('teacher_aliases')
      .select('teacher_id, normalized_key')
      .in('teacher_id', teacherIds)
      .order('teacher_id', { ascending: true })
      .order('normalized_key', { ascending: true })
      .range(from, from + ROW_PAGE - 1);
    if (error) {
      console.error('Error fetching teacher_aliases (paged):', error);
      break;
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < ROW_PAGE) break;
    from += ROW_PAGE;
  }
  return out;
}

async function fetchAllCoursesMeta(
  supabase: SupabaseClient,
  courseIds: string[],
): Promise<{ id: string; groups?: unknown }[]> {
  if (courseIds.length === 0) return [];
  const out: { id: string; groups?: unknown }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('courses')
      .select('id, groups (class_type, default_lesson_minutes)')
      .in('id', courseIds)
      .order('id', { ascending: true })
      .range(from, from + ROW_PAGE - 1);
    if (error) {
      console.error('Error fetching courses meta (paged):', error);
      break;
    }
    const rows = (data ?? []) as { id: string; groups?: unknown }[];
    out.push(...rows);
    if (rows.length < ROW_PAGE) break;
    from += ROW_PAGE;
  }
  return out;
}

async function fetchAllLessonsForCourses(supabase: SupabaseClient, courseIds: string[]): Promise<LessonRow[]> {
  if (courseIds.length === 0) return [];
  const out: LessonRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('lessons')
      .select(
        `
        id,
        course_id,
        date,
        start_time,
        end_time,
        teacher,
        courses (
          groups (
            class_type
          )
        )
      `,
      )
      .in('course_id', courseIds)
      .order('course_id', { ascending: true })
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + ROW_PAGE - 1);
    if (error) {
      console.error('Error fetching lessons (paged):', error);
      break;
    }
    const rows = (data ?? []) as LessonRow[];
    out.push(...rows);
    if (rows.length < ROW_PAGE) break;
    from += ROW_PAGE;
  }
  return out;
}

export default async function TeachersPage() {
  const supabase = getSupabaseAdmin();
  const { data: teachers, error } = await supabase.from('teachers').select('id, name, status').order('name');

  if (error) {
    console.error('Error fetching teachers:', error);
  }

  const teacherList = teachers ?? [];
  const teacherIds = teacherList.map((t) => t.id);

  const courseTeacherRows = await fetchAllCourseTeacherRows(supabase, teacherIds);

  const coursesByTeacherId = new Map<string, string[]>();
  const allCourseIds = new Set<string>();
  for (const row of courseTeacherRows) {
    if (!row.teacher_id || !row.course_id) continue;
    allCourseIds.add(row.course_id);
    const list = coursesByTeacherId.get(row.teacher_id) ?? [];
    list.push(row.course_id);
    coursesByTeacherId.set(row.teacher_id, list);
  }

  const courseIds = [...allCourseIds];

  const allAliasRows = await fetchAllTeacherAliasRows(supabase, teacherIds);

  const aliasKeysByTeacherId = new Map<string, string[]>();
  for (const row of allAliasRows) {
    if (!row.teacher_id) continue;
    const nk = String(row.normalized_key ?? '').trim();
    if (!nk) continue;
    const list = aliasKeysByTeacherId.get(row.teacher_id) ?? [];
    list.push(nk);
    aliasKeysByTeacherId.set(row.teacher_id, list);
  }

  let lessonsByCourseId: Record<string, LessonRow[]> = {};
  const classTypeByCourseId = new Map<string, ReturnType<typeof normalizeGroupClassType>>();
  const defaultLessonMinutesByCourseId = new Map<string, number | null>();

  if (courseIds.length > 0) {
    const coursesMeta = await fetchAllCoursesMeta(supabase, courseIds);
    for (const row of coursesMeta) {
      const raw = extractClassType(row.groups);
      classTypeByCourseId.set(row.id, normalizeGroupClassType(raw));
      defaultLessonMinutesByCourseId.set(row.id, extractDefaultLessonMinutes(row.groups));
    }

    const lessons = await fetchAllLessonsForCourses(supabase, courseIds);
    for (const lesson of lessons) {
      if (!lessonsByCourseId[lesson.course_id]) {
        lessonsByCourseId[lesson.course_id] = [];
      }
      lessonsByCourseId[lesson.course_id].push(lesson);
    }

    Object.values(lessonsByCourseId).forEach((courseLessons) => {
      courseLessons.sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return dateA - dateB;
      });
    });
  }

  const _now = new Date();
  const currentYear = _now.getUTCFullYear();
  const currentMonth = _now.getUTCMonth() + 1;

  const monthBuckets: { ym: string; label: string }[] = [];
  for (let i = 0; i <= 2; i += 1) {
    const d = new Date(Date.UTC(currentYear, currentMonth - 1 - i, 1));
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const ym = `${y}-${String(mo).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[mo - 1].slice(0, 3)} ${y}`;
    monthBuckets.push({ ym, label });
  }

  const teachersWithHours = teacherList.map((teacher) => {
    const lessonMatchKeys = buildTeacherLessonMatchKeys(teacher.name, aliasKeysByTeacherId.get(teacher.id) ?? []);
    const courseIdsForTeacher = new Set(coursesByTeacherId.get(teacher.id) ?? []);
    const minutesByYm: Record<string, number> = {};
    for (const courseId of courseIdsForTeacher) {
      const courseLessons = lessonsByCourseId[courseId] ?? [];
      const matched = courseLessons.filter((lesson) =>
        lessonMatchesAnyTeacherKey(lesson.teacher, lessonMatchKeys),
      );
      matched.sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return dateA - dateB;
      });
      const defaultClassType = classTypeByCourseId.get(courseId) ?? null;
      const defaultLessonMinutes = defaultLessonMinutesByCourseId.get(courseId) ?? null;
      matched.forEach((lesson, index) => {
        const lessonLevelClassType = normalizeGroupClassType(extractClassType(lesson.courses?.groups));
        const classType = lessonLevelClassType ?? defaultClassType ?? null;
        const duration = lessonDurationMinutes(lesson, index, classType, defaultLessonMinutes);
        const ym = yearMonthFromLessonDate(lesson.date);
        if (!ym) return;
        minutesByYm[ym] = (minutesByYm[ym] ?? 0) + duration;
      });
    }
    const monthHours = monthBuckets.map(({ ym }) => ({
      label: ym,
      hoursDisplay: hoursDisplayFromMinutes(minutesByYm[ym] ?? 0),
    }));
    const rawStatus = (teacher as { status?: string }).status;
    const status = rawStatus === 'inactive' ? ('inactive' as const) : ('active' as const);
    return {
      id: teacher.id,
      name: teacher.name,
      status,
      monthHours,
    };
  });

  return (
    <TeachersClient
      initialTeachers={teachersWithHours}
      monthColumnLabels={monthBuckets.map((b) => b.label)}
    />
  );
}
