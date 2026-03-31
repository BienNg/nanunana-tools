import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { lessonDurationMinutes, normalizeGroupClassType } from '@/lib/courseDuration';
import TeacherMonthDropdown from './TeacherMonthDropdown';
import TeacherSessionsSection from './TeacherSessionsSection';
import { buildTeacherLessonMatchKeys, lessonMatchesAnyTeacherKey } from '@/lib/teacherLessonMatch';

export const dynamic = 'force-dynamic';

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

function hoursDisplayFromMinutes(minutes: number): string {
  const exactHours = minutes / 60;
  return (Math.trunc(exactHours * 100) / 100).toString();
}

function sortLessonsNewestFirst(lessons: any[]) {
  return [...lessons].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    if (dateB !== dateA) return dateB - dateA;
    const timeA = a.start_time || '';
    const timeB = b.start_time || '';
    return timeB.localeCompare(timeA);
  });
}

export default async function TeacherDetailsPage({ 
  params,
  searchParams
}: { 
  params: Promise<{ id: string }>,
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const resolvedParams = await params;
  const id = resolvedParams.id;
  const resolvedSearchParams = await searchParams;
  const filter = resolvedSearchParams.filter === 'all' ? 'all' : 'monthly';
  const supabase = getSupabaseAdmin();
  
  // 1. Fetch teacher details
  const { data: teacher } = await supabase
    .from('teachers')
    .select('id, name')
    .eq('id', id)
    .single();

  if (!teacher) {
    return (
      <div className="pt-24 px-10 pb-12 text-center">
        <h2 className="text-2xl font-bold text-error mb-4">Teacher not found</h2>
        <Link href="/teachers" className="text-primary mt-4 inline-flex items-center gap-2 hover:bg-primary/5 px-4 py-2 rounded-full transition-colors font-medium">
          <span className="material-symbols-outlined">arrow_back</span>
          Back to Teachers
        </Link>
      </div>
    );
  }

  // 2. Fetch courses taught by this teacher
  const { data: courseTeachers } = await supabase
    .from('course_teachers')
    .select(`
      course_id,
      courses (
        id,
        name,
        groups ( id, name, class_type )
      )
    `)
    .eq('teacher_id', id);

  const courses = courseTeachers?.map((ct: any) => ct.courses).filter(Boolean).sort((a: any, b: any) => a.name.localeCompare(b.name)) || [];
  const courseIds = courses.map((c: any) => c.id);

  const { data: aliasRows } = await supabase
    .from('teacher_aliases')
    .select('normalized_key')
    .eq('teacher_id', id);

  const lessonMatchKeys = buildTeacherLessonMatchKeys(
    teacher.name,
    (aliasRows ?? [])
      .map((r: { normalized_key: string | null }) => String(r.normalized_key ?? '').trim())
      .filter(Boolean)
  );

  // 3. Fetch lessons with attendance records
  let allLessons: any[] = [];
  // Current month built from UTC components — avoids all timezone/locale bugs
  const _now = new Date();
  const currentYear = _now.getUTCFullYear();
  const currentMonth = _now.getUTCMonth() + 1; // 1-based
  const currentYearMonth = `${currentYear}-${String(currentMonth).padStart(2, '0')}`; // "2026-03"
  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  if (courseIds.length > 0) {
    const { data: lessonsData } = await supabase
      .from('lessons')
      .select(`
        id,
        course_id,
        date,
        start_time,
        end_time,
        slide_id,
        teacher,
        attendance_records (
          status
        ),
        courses (
          name,
          groups (
            class_type
          )
        )
      `)
      .in('course_id', courseIds);
      
    allLessons = (lessonsData || []).filter((lesson: { teacher?: unknown }) =>
      lessonMatchesAnyTeacherKey(lesson.teacher, lessonMatchKeys),
    );
  }

  const availableYearMonths = (() => {
    const set = new Set<string>();
    for (const lesson of allLessons) {
      const ym = yearMonthFromLessonDate(lesson.date);
      if (ym) set.add(ym);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  })();

  const rawMonth = resolvedSearchParams.month;
  const monthParamStr =
    typeof rawMonth === 'string'
      ? rawMonth
      : Array.isArray(rawMonth) && rawMonth[0]
        ? rawMonth[0]
        : undefined;
  const monthParamValid =
    monthParamStr && /^\d{4}-\d{2}$/.test(monthParamStr) ? monthParamStr : undefined;

  let selectedYearMonth = currentYearMonth;
  if (filter === 'monthly' && monthParamValid) {
    selectedYearMonth = monthParamValid;
  }

  const selectedMonthParts = selectedYearMonth.split('-');
  const selectedMonthLabel = `${MONTH_NAMES[Number(selectedMonthParts[1]) - 1]} ${selectedMonthParts[0]}`;

  const monthOptions = availableYearMonths.map((ym) => {
    const [y, mo] = ym.split('-');
    return {
      value: ym,
      label: `${MONTH_NAMES[Number(mo) - 1]} ${y}`,
    };
  });

  const allTeacherLessons = allLessons;
  if (courseIds.length > 0 && filter === 'monthly') {
    allLessons = allTeacherLessons.filter(
      (lesson) =>
        typeof lesson.date === 'string' && lesson.date.startsWith(selectedYearMonth),
    );
  }

  // Unique students in courses that have at least one lesson in the current scope (teacher-taught + period)
  let totalStudents = 0;
  const courseIdsInScope = [...new Set(allLessons.map((l: { course_id: string }) => l.course_id))];
  if (courseIdsInScope.length > 0) {
    const { data: courseStudents } = await supabase
      .from('course_students')
      .select('student_id')
      .in('course_id', courseIdsInScope);

    const uniqueStudentIds = new Set(courseStudents?.map((cs) => cs.student_id));
    totalStudents = uniqueStudentIds.size;
  }

  // Metrics Calculation
  const coursesTaught = new Set(allLessons.map((l: { course_id: string }) => l.course_id)).size;
  const classTypeByCourseId = new Map<string, ReturnType<typeof normalizeGroupClassType>>();
  courses.forEach((course: any) => {
    const rawClassType = extractClassType(course?.groups);
    classTypeByCourseId.set(course.id, normalizeGroupClassType(rawClassType));
  });

  const lessonsByCourseId: Record<string, any[]> = {};
  allTeacherLessons.forEach((lesson) => {
    if (!lessonsByCourseId[lesson.course_id]) {
      lessonsByCourseId[lesson.course_id] = [];
    }
    lessonsByCourseId[lesson.course_id].push(lesson);
  });

  Object.values(lessonsByCourseId).forEach((courseLessons) => {
    courseLessons.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateA - dateB;
    });

    courseLessons.forEach((lesson, index) => {
      const lessonLevelClassType = normalizeGroupClassType(extractClassType(lesson.courses?.groups));
      const classType = lessonLevelClassType ?? classTypeByCourseId.get(lesson.course_id) ?? null;
      const duration = lessonDurationMinutes(lesson, index, classType);
      lesson.calculatedDurationMinutes = duration;
    });
  });

  const totalMinutes = allLessons.reduce(
    (sum, lesson) => sum + (lesson.calculatedDurationMinutes || 0),
    0,
  );

  const totalHoursDisplay = hoursDisplayFromMinutes(totalMinutes);

  let totalAttendanceRecords = 0;
  let presentRecords = 0;
  allLessons.forEach(lesson => {
    const records = lesson.attendance_records || [];
    totalAttendanceRecords += records.length;
    presentRecords += records.filter((r: any) => r.status === 'Present').length;
  });
  const avgAttendance = totalAttendanceRecords > 0 
    ? Math.round((presentRecords / totalAttendanceRecords) * 100) 
    : 0;

  // Hours trend: always last 6 calendar months (UTC), independent of month filter
  const minutesByYearMonth: Record<string, number> = {};
  for (const lesson of allTeacherLessons) {
    const ym = yearMonthFromLessonDate(lesson.date);
    if (!ym) continue;
    minutesByYearMonth[ym] =
      (minutesByYearMonth[ym] ?? 0) + (lesson.calculatedDurationMinutes || 0);
  }

  const trendMonthBuckets: { ym: string; label: string }[] = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(currentYear, currentMonth - 1 - i, 1));
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const ym = `${y}-${String(mo).padStart(2, '0')}`;
    const label = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    trendMonthBuckets.push({ ym, label });
  }

  const trendData = trendMonthBuckets.map(({ ym, label }) => {
    const minutes = minutesByYearMonth[ym] ?? 0;
    return {
      ym,
      label,
      minutes,
      hours: minutes / 60,
    };
  });

  const peakHours = Math.max(0, ...trendData.map((d) => d.hours));
  const yAxisMax = Math.max(1, Math.ceil(peakHours));
  const yMid = yAxisMax / 2;

  const totalLessons = allLessons.length;

  const courseMetaById = new Map(courses.map((course: any) => [course.id, course]));
  type GroupCourseInPeriod = {
    courseId: string;
    name: string;
    lessonsCount: number;
    minutesTaught: number;
  };
  const groupsInPeriodMap = new Map<
    string,
    {
      groupId: string;
      name: string;
      lessonsCount: number;
      minutesTaught: number;
      coursesMap: Map<string, GroupCourseInPeriod>;
    }
  >();
  allLessons.forEach((lesson) => {
    const courseMeta = courseMetaById.get(lesson.course_id);
    const courseGroup = Array.isArray(courseMeta?.groups) ? courseMeta.groups[0] : courseMeta?.groups;
    const groupId = courseGroup?.id;
    if (!groupId) return;

    const mins = typeof lesson.calculatedDurationMinutes === 'number' ? lesson.calculatedDurationMinutes : 0;
    const existing = groupsInPeriodMap.get(groupId);
    if (existing) {
      existing.lessonsCount += 1;
      existing.minutesTaught += mins;
      let courseRow = existing.coursesMap.get(lesson.course_id);
      if (!courseRow) {
        courseRow = {
          courseId: lesson.course_id,
          name: courseMeta?.name ?? 'Course',
          lessonsCount: 0,
          minutesTaught: 0,
        };
        existing.coursesMap.set(lesson.course_id, courseRow);
      }
      courseRow.lessonsCount += 1;
      courseRow.minutesTaught += mins;
      return;
    }

    const courseRow: GroupCourseInPeriod = {
      courseId: lesson.course_id,
      name: courseMeta?.name ?? 'Course',
      lessonsCount: 1,
      minutesTaught: mins,
    };
    groupsInPeriodMap.set(groupId, {
      groupId,
      name: courseGroup?.name ?? 'Unknown group',
      lessonsCount: 1,
      minutesTaught: mins,
      coursesMap: new Map([[lesson.course_id, courseRow]]),
    });
  });

  const groupsInPeriod = Array.from(groupsInPeriodMap.values())
    .map((row) => ({
      groupId: row.groupId,
      name: row.name,
      lessonsCount: row.lessonsCount,
      minutesTaught: row.minutesTaught,
      courses: Array.from(row.coursesMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const periodGroupsSubtitle =
    filter === 'monthly' ? selectedMonthLabel : 'All time';

  const sortedPeriodLessons = sortLessonsNewestFirst(allLessons);
  const allSessionsSorted = sortedPeriodLessons;

  const courseIdsInPeriod = [...new Set(allLessons.map((l: { course_id: string }) => l.course_id))].sort(
    (a, b) => {
      const courseA = courseMetaById.get(a) as any;
      const courseB = courseMetaById.get(b) as any;
      return (courseA?.name ?? '').localeCompare(courseB?.name ?? '');
    },
  );

  const sessionCourseTabs = courseIdsInPeriod.map((courseId) => {
    const course = courseMetaById.get(courseId) as any;
    return {
      courseId,
      name: course?.name ?? 'Course',
      sessions: sortedPeriodLessons.filter((lesson) => lesson.course_id === courseId),
    };
  });

  return (
    <main className="min-h-screen transition-[margin] duration-300 ease-out bg-surface-bright">
      <div className="pt-24 px-10 pb-12 animate-fade-up max-w-7xl mx-auto">
        
        {/* Navigation & Header */}
        <div className="mb-12">
          <Link href="/teachers" className="text-primary text-sm font-semibold inline-flex items-center gap-1 mb-6 hover:bg-primary/5 px-3 py-1.5 -ml-3 rounded-full transition-colors">
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back to Teachers
          </Link>
          <div className="flex flex-col md:flex-row justify-between items-end gap-6">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-3xl">badge</span>
              </div>
              <div>
                <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-on-surface font-headline">
                  {teacher.name}
                </h2>
                <p className="text-on-surface-variant font-medium mt-1">
                  Faculty metrics & performance overview
                </p>
              </div>
            </div>
            
            {/* Filter Toggle */}
            <div className="flex items-center bg-surface-container-lowest shadow-sm p-1 rounded-xl border border-outline-variant/10">
              <Link 
                href={`/teachers/${id}?filter=all`}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${filter === 'all' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
              >
                All Time
              </Link>
              <Link 
                href={`/teachers/${id}`}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${filter === 'monthly' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
              >
                Monthly
              </Link>
              {filter === 'monthly' && (
                <>
                  <div className="h-6 w-px bg-outline-variant/30 mx-2"></div>
                  <TeacherMonthDropdown
                    teacherId={id}
                    months={monthOptions}
                    selectedValue={selectedYearMonth}
                    selectedLabel={selectedMonthLabel}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        {/* KPI Cards - Bento Grid Style */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
          <div className="bg-surface-container-lowest p-6 rounded-3xl border border-outline-variant/5 group hover:bg-primary-fixed transition-colors">
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-1 group-hover:text-primary">Courses Taught</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold font-headline">{coursesTaught}</span>
            </div>
          </div>
          
          <div className="bg-surface-container-lowest p-6 rounded-3xl border border-outline-variant/5 group hover:bg-primary-fixed transition-colors">
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-1 group-hover:text-primary">Lessons Scheduled</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold font-headline">{totalLessons}</span>
            </div>
          </div>
          
          <div className="bg-surface-container-lowest p-6 rounded-3xl border border-outline-variant/5 group hover:bg-primary-fixed transition-colors">
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-1 group-hover:text-primary">Total Hours</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold font-headline">{totalHoursDisplay}</span>
              <span className="text-on-surface-variant text-[10px] font-bold">hrs</span>
            </div>
          </div>
          
          <div className="bg-surface-container-lowest p-6 rounded-3xl border border-outline-variant/5 group hover:bg-primary-fixed transition-colors">
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-1 group-hover:text-primary">Total Students</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold font-headline">{totalStudents}</span>
            </div>
          </div>
          
          <div className="bg-surface-container-lowest p-6 rounded-3xl border border-outline-variant/5 group hover:bg-primary-fixed transition-colors">
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-1 group-hover:text-primary">Avg. Attendance</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold font-headline text-tertiary">{avgAttendance}%</span>
            </div>
          </div>
        </div>

        {/* Asymmetric Data Section */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8">
          {/* Main Trend Visualization */}
          <div className="lg:col-span-8 bg-surface-container-low rounded-3xl p-8 min-h-[400px] flex flex-col border border-outline-variant/10">
            <div className="mb-6">
              <h3 className="text-xl font-bold font-headline">Teaching hours</h3>
              <p className="text-sm text-on-surface-variant font-medium mt-1">
                Last 6 months · hours taught per month
              </p>
            </div>

            <div className="flex-1 flex gap-3 min-h-[280px] items-end">
              <div className="flex flex-col justify-between h-[200px] shrink-0 mb-10 text-[11px] font-semibold text-on-surface-variant tabular-nums text-right pr-2 w-11 border-r border-outline-variant/15">
                <span>{yAxisMax}h</span>
                <span>{yMid % 1 === 0 ? yMid : yMid.toFixed(1)}h</span>
                <span>0</span>
              </div>
              <div className="flex-1 relative min-h-[260px] min-w-0 pb-1">
                <div className="absolute inset-x-0 top-0 h-[200px] flex flex-col justify-between pointer-events-none">
                  <div className="h-px bg-outline-variant/15" />
                  <div className="h-px bg-outline-variant/15" />
                  <div className="h-px bg-outline-variant/20" />
                </div>
                <div className="relative h-full flex items-end justify-around gap-2 sm:gap-3 px-0 sm:px-1 pt-2">
                  {trendData.map(({ ym, label, minutes, hours }) => {
                    const barTrackPx = 200;
                    const rawBarPx = yAxisMax > 0 ? (hours / yAxisMax) * barTrackPx : 0;
                    const barPx = hours > 0 ? Math.max(rawBarPx, 10) : 0;
                    const hoursLabel = hoursDisplayFromMinutes(minutes);
                    const hoursTitle = `${hoursLabel} hours`;

                    return (
                      <div
                        key={ym}
                        className="flex flex-col items-center flex-1 min-w-0 justify-end gap-2"
                      >
                        <div
                          className="w-full max-w-[52px] mx-auto flex flex-col items-center justify-end"
                          style={{ height: barTrackPx }}
                        >
                          {hours > 0 ? (
                            <span
                              className="text-[11px] font-bold tabular-nums text-on-surface mb-1.5 leading-none"
                              title={hoursTitle}
                            >
                              {hoursLabel}
                              <span className="text-on-surface-variant font-semibold">h</span>
                            </span>
                          ) : (
                            <span className="text-[11px] font-semibold tabular-nums text-on-surface-variant/70 mb-1.5">
                              —
                            </span>
                          )}
                          <div
                            className="w-full rounded-t-xl bg-primary mt-auto transition-[height] duration-300 shadow-sm shadow-primary/25"
                            style={{ height: barPx }}
                            title={hoursTitle}
                          />
                        </div>
                        <span className="text-[11px] font-bold text-on-surface-variant shrink-0 tracking-wide">
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Groups taught in selected period */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            <div className="bg-surface-container-lowest rounded-3xl p-8 border border-outline-variant/10 flex-1 flex flex-col min-h-0">
              <div className="mb-6">
                <h3 className="text-lg font-bold font-headline">Groups taught</h3>
                <p className="text-sm text-on-surface-variant font-medium mt-1">{periodGroupsSubtitle}</p>
              </div>
              {groupsInPeriod.length > 0 ? (
                <ul className="space-y-2 overflow-y-auto flex-1 -mr-2 pr-2 max-h-[280px]">
                  {groupsInPeriod.map((row) => (
                    <li key={row.groupId}>
                      <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
                        <Link
                          href={`/groups/${row.groupId}`}
                          className="flex items-center gap-3 hover:bg-surface-container-low transition-colors px-4 py-3 group"
                        >
                          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                            <span className="material-symbols-outlined text-xl">groups</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-on-surface truncate">{row.name}</p>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                              <span className="text-xs font-semibold text-on-surface-variant">
                                {row.lessonsCount} lesson{row.lessonsCount === 1 ? '' : 's'}
                              </span>
                              <span className="text-xs font-semibold text-on-surface-variant">
                                · {hoursDisplayFromMinutes(row.minutesTaught)} hrs
                              </span>
                            </div>
                          </div>
                          <span className="material-symbols-outlined text-outline group-hover:text-primary transition-colors shrink-0 text-lg">
                            chevron_right
                          </span>
                        </Link>
                        {row.courses.length > 0 && (
                          <ul className="border-t border-outline-variant/10 bg-surface-container-lowest/50 px-3 py-2 space-y-0.5">
                            {row.courses.map((c) => (
                              <li key={c.courseId}>
                                <Link
                                  href={`/courses/${c.courseId}`}
                                  className="flex items-start justify-between gap-2 rounded-xl px-2 py-1.5 text-xs hover:bg-surface-container-low/80 transition-colors group/course"
                                >
                                  <span className="font-semibold text-on-surface truncate min-w-0">
                                    {c.name}
                                  </span>
                                  <span className="shrink-0 tabular-nums text-on-surface-variant font-medium text-right">
                                    {c.lessonsCount} lesson{c.lessonsCount === 1 ? '' : 's'}
                                    <span className="mx-1 text-outline-variant">·</span>
                                    {hoursDisplayFromMinutes(c.minutesTaught)} hrs
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-on-surface-variant font-medium flex-1">
                  No lessons in this period.
                </p>
              )}
            </div>
          </div>
        </div>

        <TeacherSessionsSection allSessions={allSessionsSorted} courseTabs={sessionCourseTabs} />

      </div>
    </main>
  );
}