import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  lessonDurationMinutes,
  normalizeGroupClassType,
  normalizeGroupDefaultLessonMinutes,
} from '@/lib/courseDuration';
import HoursTaughtChartClient from './HoursTaughtChartClient';

function yearMonthFromLessonDate(dateStr: unknown): string | null {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

export default async function HoursTaughtChart() {
  const supabase = getSupabaseAdmin();

  // 1. Fetch courses and groups to get class types and default minutes
  const { data: coursesData } = await supabase
    .from('courses')
    .select('id, groups ( class_type, default_lesson_minutes )');

  const classTypeByCourseId = new Map<string, any>();
  const defaultLessonMinutesByCourseId = new Map<string, number | null>();

  (coursesData || []).forEach((course) => {
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
    courseLessons.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      if (dateA !== dateB) return dateA - dateB;
      const timeA = a.start_time || '';
      const timeB = b.start_time || '';
      return timeA.localeCompare(timeB);
    });

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

  const minutesByYearMonth: Record<string, number> = {};
  trendMonthBuckets.forEach(b => {
    minutesByYearMonth[b.ym] = 0;
  });

  for (const lesson of allLessons) {
    const ym = yearMonthFromLessonDate(lesson.date);
    if (!ym) continue;
    if (minutesByYearMonth[ym] !== undefined) {
      minutesByYearMonth[ym] += lesson.calculatedDurationMinutes || 0;
    }
  }

  const chartData = trendMonthBuckets.map(({ ym, label }) => {
    const minutes = minutesByYearMonth[ym] ?? 0;
    return {
      ym,
      label,
      minutes,
      hours: minutes / 60,
    };
  });

  return <HoursTaughtChartClient data={chartData} />;
}
