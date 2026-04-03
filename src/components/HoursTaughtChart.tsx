import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  compareLessonsChronologically,
  GroupClassType,
  lessonDurationMinutes,
  normalizeGroupClassType,
  normalizeGroupDefaultLessonMinutes,
} from '@/lib/courseDuration';
import HoursTaughtChartClient from './HoursTaughtChartClient';

type HoursTaughtChartClientData = Parameters<typeof HoursTaughtChartClient>[0]['data'];
type HoursTaughtChartDataPoint = HoursTaughtChartClientData[number];
type HoursTaughtClassType = HoursTaughtChartDataPoint['classTypeHours'][number]['classType'];

function yearMonthFromLessonDate(dateStr: unknown): string | null {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

/** Groups display names like "A2.2 Online VN" → "A2.2_ONLINE_VN" for stacked segments. */
function normalizeCourseStackKey(name: string): string {
  const t = name.trim();
  if (!t) return 'UNKNOWN_COURSE';
  return t.replace(/\s+/g, '_').toUpperCase();
}

export default async function HoursTaughtChart() {
  const supabase = getSupabaseAdmin();

  // 1. Fetch courses and groups to get class types and default minutes
  const { data: coursesData } = await supabase
    .from('courses')
    .select('id, name, groups ( class_type, default_lesson_minutes )');

  const classTypeByCourseId = new Map<string, GroupClassType | null>();
  const defaultLessonMinutesByCourseId = new Map<string, number | null>();
  const courseNameById = new Map<string, string>();

  (coursesData || []).forEach((course) => {
    courseNameById.set(course.id, typeof course.name === 'string' ? course.name : '');
    const group = Array.isArray(course.groups) ? course.groups[0] : course.groups;
    classTypeByCourseId.set(course.id, normalizeGroupClassType(group?.class_type));
    defaultLessonMinutesByCourseId.set(
      course.id,
      normalizeGroupDefaultLessonMinutes(group?.default_lesson_minutes)
    );
  });

  // 2. Fetch all lessons (paginated to ensure we get everything for accurate first-lesson calc)
  let allLessons: any[] = [];
  let hasMore = true;
  let offset = 0;
  const pageSize = 1000;

  while (hasMore) {
    const { data, error } = await supabase
      .from('lessons')
      .select('id, course_id, date, start_time, end_time')
      .range(offset, offset + pageSize - 1);

    if (error || !data || data.length === 0) {
      hasMore = false;
    } else {
      allLessons.push(...data);
      offset += pageSize;
      if (data.length < pageSize) hasMore = false;
    }
  }

  // 3. Group by course and sort chronologically to calculate duration accurately
  const lessonsByCourseId: Record<string, any[]> = {};
  allLessons.forEach((lesson) => {
    if (!lessonsByCourseId[lesson.course_id]) {
      lessonsByCourseId[lesson.course_id] = [];
    }
    lessonsByCourseId[lesson.course_id].push(lesson);
  });

  Object.values(lessonsByCourseId).forEach((courseLessons) => {
    courseLessons.sort(compareLessonsChronologically);

    courseLessons.forEach((lesson, index) => {
      const classType = classTypeByCourseId.get(lesson.course_id) ?? null;
      const defaultLessonMinutes = defaultLessonMinutesByCourseId.get(lesson.course_id) ?? null;
      lesson.calculatedDurationMinutes = lessonDurationMinutes(
        lesson,
        index,
        classType,
        defaultLessonMinutes
      );
    });
  });

  // 4. Calculate last 6 months buckets
  const _now = new Date();
  const currentYear = _now.getUTCFullYear();
  const currentMonth = _now.getUTCMonth() + 1;

  const trendMonthBuckets: { ym: string; label: string }[] = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(currentYear, currentMonth - 1 - i, 1));
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const ym = `${y}-${String(mo).padStart(2, '0')}`;
    const label = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    trendMonthBuckets.push({ ym, label });
  }

  const CLASS_TYPE_ORDER: readonly GroupClassType[] = [
    'Online_DE',
    'Online_VN',
    'Offline',
    'M',
    'A',
    'P',
  ];
  const UNKNOWN_CLASS_TYPE_KEY: Extract<HoursTaughtClassType, 'Unknown'> = 'Unknown';
  type ClassTypeBucketKey = Exclude<HoursTaughtClassType, 'Unknown'> | typeof UNKNOWN_CLASS_TYPE_KEY;

  const minutesByYearMonth: Record<string, number> = {};
  const minutesByYearMonthAndClassType: Record<string, Record<ClassTypeBucketKey, number>> = {};
  const sessionsByYearMonth: Record<string, number> = {};
  const sessionsByYearMonthAndClassType: Record<string, Record<ClassTypeBucketKey, number>> = {};
  const groupsByYearMonth: Record<string, Set<string>> = {};
  const groupsByYearMonthAndClassType: Record<string, Record<ClassTypeBucketKey, Set<string>>> = {};
  const studentsPresentByYmAndStack: Record<string, Record<string, Set<string>>> = {};
  trendMonthBuckets.forEach(b => {
    minutesByYearMonth[b.ym] = 0;
    minutesByYearMonthAndClassType[b.ym] = {
      Online_DE: 0,
      Online_VN: 0,
      Offline: 0,
      M: 0,
      A: 0,
      P: 0,
      Unknown: 0,
    };
    sessionsByYearMonth[b.ym] = 0;
    sessionsByYearMonthAndClassType[b.ym] = {
      Online_DE: 0,
      Online_VN: 0,
      Offline: 0,
      M: 0,
      A: 0,
      P: 0,
      Unknown: 0,
    };
    groupsByYearMonth[b.ym] = new Set<string>();
    groupsByYearMonthAndClassType[b.ym] = {
      Online_DE: new Set<string>(),
      Online_VN: new Set<string>(),
      Offline: new Set<string>(),
      M: new Set<string>(),
      A: new Set<string>(),
      P: new Set<string>(),
      Unknown: new Set<string>(),
    };
    studentsPresentByYmAndStack[b.ym] = {};
  });

  for (const lesson of allLessons) {
    const ym = yearMonthFromLessonDate(lesson.date);
    if (!ym) continue;
    if (minutesByYearMonth[ym] !== undefined) {
      const lessonMinutes = lesson.calculatedDurationMinutes || 0;
      minutesByYearMonth[ym] += lessonMinutes;
      const classType = classTypeByCourseId.get(lesson.course_id) ?? null;
      const classTypeKey: ClassTypeBucketKey = classType ?? UNKNOWN_CLASS_TYPE_KEY;
      minutesByYearMonthAndClassType[ym][classTypeKey] += lessonMinutes;
      sessionsByYearMonth[ym] += 1;
      sessionsByYearMonthAndClassType[ym][classTypeKey] += 1;
      if (typeof lesson.course_id === 'string' && lesson.course_id.length > 0) {
        groupsByYearMonth[ym].add(lesson.course_id);
        groupsByYearMonthAndClassType[ym][classTypeKey].add(lesson.course_id);
      }
    }
  }

  const trendYmSet = new Set(trendMonthBuckets.map((b) => b.ym));
  const lessonYmById = new Map<string, string>();
  const lessonCourseById = new Map<string, string>();
  for (const lesson of allLessons) {
    if (typeof lesson.id !== 'string' || typeof lesson.course_id !== 'string') continue;
    lessonCourseById.set(lesson.id, lesson.course_id);
    const ym = yearMonthFromLessonDate(lesson.date);
    if (ym && trendYmSet.has(ym)) lessonYmById.set(lesson.id, ym);
  }

  let attendanceRows: { lesson_id: string; student_id: string; status: string }[] = [];
  offset = 0;
  hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase
      .from('attendance_records')
      .select('lesson_id, student_id, status')
      .range(offset, offset + pageSize - 1);

    if (error || !data || data.length === 0) {
      hasMore = false;
    } else {
      attendanceRows.push(...data);
      offset += pageSize;
      if (data.length < pageSize) hasMore = false;
    }
  }

  for (const row of attendanceRows) {
    if (row.status !== 'Present') continue;
    const ym = lessonYmById.get(row.lesson_id);
    if (!ym) continue;
    const courseId = lessonCourseById.get(row.lesson_id);
    if (!courseId) continue;
    const stackKey = normalizeCourseStackKey(courseNameById.get(courseId) ?? '');
    const bucket = studentsPresentByYmAndStack[ym];
    if (!bucket[stackKey]) bucket[stackKey] = new Set();
    bucket[stackKey].add(row.student_id);
  }

  const chartData: HoursTaughtChartClientData = trendMonthBuckets.map(({ ym, label }) => {
    const minutes = minutesByYearMonth[ym] ?? 0;
    const sessions = sessionsByYearMonth[ym] ?? 0;
    const groups = groupsByYearMonth[ym]?.size ?? 0;
    const courseStudentStacks = Object.entries(studentsPresentByYmAndStack[ym] ?? {})
      .map(([stackKey, set]) => ({ stackKey, students: set.size }))
      .filter((e) => e.students > 0)
      .sort((a, b) => a.stackKey.localeCompare(b.stackKey));
    return {
      ym,
      label,
      minutes,
      hours: minutes / 60,
      sessions,
      groups,
      courseStudentStacks,
      classTypeHours: [
        ...CLASS_TYPE_ORDER.map((classType) => ({
          classType,
          minutes: minutesByYearMonthAndClassType[ym][classType],
          hours: minutesByYearMonthAndClassType[ym][classType] / 60,
        })),
        {
          classType: UNKNOWN_CLASS_TYPE_KEY,
          minutes: minutesByYearMonthAndClassType[ym][UNKNOWN_CLASS_TYPE_KEY],
          hours: minutesByYearMonthAndClassType[ym][UNKNOWN_CLASS_TYPE_KEY] / 60,
        },
      ],
      classTypeSessions: [
        ...CLASS_TYPE_ORDER.map((classType) => ({
          classType,
          sessions: sessionsByYearMonthAndClassType[ym][classType],
        })),
        {
          classType: UNKNOWN_CLASS_TYPE_KEY,
          sessions: sessionsByYearMonthAndClassType[ym][UNKNOWN_CLASS_TYPE_KEY],
        },
      ],
      classTypeGroups: [
        ...CLASS_TYPE_ORDER.map((classType) => ({
          classType,
          groups: groupsByYearMonthAndClassType[ym][classType].size,
        })),
        {
          classType: UNKNOWN_CLASS_TYPE_KEY,
          groups: groupsByYearMonthAndClassType[ym][UNKNOWN_CLASS_TYPE_KEY].size,
        },
      ],
    };
  });

  return <HoursTaughtChartClient data={chartData} />;
}
