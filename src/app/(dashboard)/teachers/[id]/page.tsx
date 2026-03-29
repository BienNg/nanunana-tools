import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { lessonDurationMinutes, normalizeGroupClassType } from '@/lib/courseDuration';

export const dynamic = 'force-dynamic';

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
  const filter = resolvedSearchParams.filter === 'monthly' ? 'monthly' : 'all';
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

  // 3. Fetch unique students count
  let totalStudents = 0;
  if (courseIds.length > 0) {
    const { data: courseStudents } = await supabase
      .from('course_students')
      .select('student_id')
      .in('course_id', courseIds);
      
    const uniqueStudentIds = new Set(courseStudents?.map(cs => cs.student_id));
    totalStudents = uniqueStudentIds.size;
  }

  // 4. Fetch lessons with attendance records
  let allLessons: any[] = [];
  // Current month built from UTC components — avoids all timezone/locale bugs
  const _now = new Date();
  const currentYear = _now.getUTCFullYear();
  const currentMonth = _now.getUTCMonth() + 1; // 1-based
  const currentYearMonth = `${currentYear}-${String(currentMonth).padStart(2, '0')}`; // "2026-03"
  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentMonthLabel = `${MONTH_NAMES[currentMonth - 1]} ${currentYear}`; // "March 2026"

  if (courseIds.length > 0) {
    const { data: lessonsData } = await supabase
      .from('lessons')
      .select(`
        id,
        course_id,
        date,
        start_time,
        end_time,
        content,
        slide_id,
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
      
    allLessons = lessonsData || [];

    if (filter === 'monthly') {
      allLessons = allLessons.filter(lesson =>
        typeof lesson.date === 'string' && lesson.date.startsWith(currentYearMonth)
      );
    }
  }

  // Metrics Calculation
  const coursesTaught = courses.length;

  let totalMinutes = 0;
  const lessonsByCourseId: Record<string, any[]> = {};
  allLessons.forEach(lesson => {
    if (!lessonsByCourseId[lesson.course_id]) {
      lessonsByCourseId[lesson.course_id] = [];
    }
    lessonsByCourseId[lesson.course_id].push(lesson);
  });

  Object.values(lessonsByCourseId).forEach(courseLessons => {
    courseLessons.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateA - dateB;
    });
    
    courseLessons.forEach((lesson, index) => {
      const classType = normalizeGroupClassType(lesson.courses?.groups?.class_type);
      const duration = lessonDurationMinutes(lesson, index, classType);
      lesson.calculatedDurationMinutes = duration;
      totalMinutes += duration;
    });
  });

  const totalHoursDisplay = Math.floor(totalMinutes / 60);

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

  // Monthly Trend
  const monthlyStats: Record<string, { sessions: number, minutes: number }> = {};
  allLessons.forEach(lesson => {
    if (lesson.date) {
      const dateObj = new Date(lesson.date);
      const monthStr = dateObj.toLocaleString('en-US', { month: 'short' }).toUpperCase();
      if (!monthlyStats[monthStr]) {
        monthlyStats[monthStr] = { sessions: 0, minutes: 0 };
      }
      monthlyStats[monthStr].sessions += 1;
      monthlyStats[monthStr].minutes += (lesson.calculatedDurationMinutes || 0);
    }
  });

  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const trendData = Object.entries(monthlyStats)
    .sort((a, b) => monthNames.indexOf(a[0]) - monthNames.indexOf(b[0]))
    .slice(-6);

  const maxSessions = Math.max(...trendData.map(d => d[1].sessions), 1);
  const maxHours = Math.max(...trendData.map(d => d[1].minutes / 60), 1);

  // Engagement Metrics
  let slidesCheckedCount = 0;
  let completedCount = 0;
  const now = new Date();
  allLessons.forEach(lesson => {
    if (lesson.slide_id) slidesCheckedCount++;
    if (lesson.date && new Date(lesson.date) < now) completedCount++;
  });
  const totalLessons = allLessons.length;
  const slidesCheckedRate = totalLessons > 0 ? Math.round((slidesCheckedCount / totalLessons) * 100) : 0;
  const courseCompletionRate = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

  // Recent Sessions
  const recentSessions = [...allLessons]
    .sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      if (dateB !== dateA) return dateB - dateA;
      const timeA = a.start_time || '';
      const timeB = b.start_time || '';
      return timeB.localeCompare(timeA);
    })
    .slice(0, 10);

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
                href={`/teachers/${id}?filter=monthly`}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${filter === 'monthly' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
              >
                Monthly
              </Link>
              {filter === 'monthly' && (
                <>
                  <div className="h-6 w-px bg-outline-variant/30 mx-2"></div>
                  <div className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-primary">
                    <span className="material-symbols-outlined text-base">calendar_today</span>
                    {currentMonthLabel}
                  </div>
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
          
          <div className="bg-surface-container-lowest p-6 rounded-3xl border border-outline-variant/5 group hover:bg-primary-fixed transition-colors">
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-1 group-hover:text-primary">Lessons Scheduled</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold font-headline">{totalLessons}</span>
            </div>
          </div>
        </div>

        {/* Asymmetric Data Section */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8">
          {/* Main Trend Visualization */}
          <div className="lg:col-span-8 bg-surface-container-low rounded-3xl p-8 min-h-[400px] flex flex-col border border-outline-variant/10">
            <div className="flex justify-between items-center mb-10">
              <h3 className="text-xl font-bold font-headline">Classes & Hours Trend</h3>
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-primary"></span>
                  <span className="text-xs font-bold text-on-surface-variant uppercase">Sessions</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-secondary-container"></span>
                  <span className="text-xs font-bold text-on-surface-variant uppercase">Hours</span>
                </div>
              </div>
            </div>
            
            <div className="flex-1 flex items-end justify-around gap-4 px-4 pb-4">
              {trendData.length > 0 ? trendData.map(([month, data]) => {
                const sessionHeight = maxSessions > 0 ? `${(data.sessions / maxSessions) * 100}%` : '0%';
                const hoursHeight = maxHours > 0 ? `${((data.minutes / 60) / maxHours) * 100}%` : '0%';
                
                return (
                  <div key={month} className="flex flex-col items-center gap-4 flex-1 h-full justify-end">
                    <div className="w-full flex justify-center gap-1 h-[200px] items-end">
                      <div 
                        className="w-3 bg-primary rounded-t-full min-h-[4px]" 
                        style={{ height: sessionHeight }}
                        title={`${data.sessions} sessions`}
                      ></div>
                      <div 
                        className="w-3 bg-secondary-container rounded-t-full opacity-60 min-h-[4px]" 
                        style={{ height: hoursHeight }}
                        title={`${Math.round(data.minutes / 60)} hours`}
                      ></div>
                    </div>
                    <span className="text-[10px] font-bold text-on-surface-variant">{month}</span>
                  </div>
                );
              }) : (
                <div className="w-full flex justify-center items-center h-[200px] text-on-surface-variant">
                  No data available to display trends.
                </div>
              )}
            </div>
          </div>

          {/* Engagement Metrics */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            <div className="bg-surface-container-lowest rounded-3xl p-8 border border-outline-variant/10 flex-1">
              <h3 className="text-lg font-bold font-headline mb-6">Engagement & Progress</h3>
              <div className="space-y-6">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-semibold">Avg. Attendance</span>
                    <span className="text-sm font-bold text-tertiary">{avgAttendance}%</span>
                  </div>
                  <div className="w-full h-2 bg-surface-container-high rounded-full overflow-hidden">
                    <div className="h-full bg-tertiary rounded-full" style={{ width: `${avgAttendance}%` }}></div>
                  </div>
                </div>
                
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-semibold">Course Completion</span>
                    <span className="text-sm font-bold text-primary">{courseCompletionRate}%</span>
                  </div>
                  <div className="w-full h-2 bg-surface-container-high rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${courseCompletionRate}%` }}></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-semibold">Slides Checked</span>
                    <span className="text-sm font-bold text-secondary-container">{slidesCheckedRate}%</span>
                  </div>
                  <div className="w-full h-2 bg-surface-container-high rounded-full overflow-hidden">
                    <div className="h-full bg-secondary-container rounded-full" style={{ width: `${slidesCheckedRate}%` }}></div>
                  </div>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-outline-variant/10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-tertiary/10 flex items-center justify-center">
                    <span className="material-symbols-outlined text-tertiary">workspace_premium</span>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-on-surface-variant uppercase tracking-tighter">Status</p>
                    <p className="text-sm font-bold">
                      {avgAttendance > 90 ? 'High Performing Faculty' : 'Active Faculty'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Recent Sessions Section */}
        <div className="bg-surface-container-lowest rounded-3xl p-8 border border-outline-variant/5">
          <div className="flex justify-between items-center mb-8">
            <div>
              <h3 className="text-xl font-bold font-headline">Recent Sessions</h3>
              <p className="text-sm text-on-surface-variant font-medium">Detailed log of the last {recentSessions.length} educational interventions.</p>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-on-surface-variant">
                  <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Date & Time</th>
                  <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Session Title</th>
                  <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Students</th>
                  <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Duration</th>
                  <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Status</th>
                  <th className="pb-6 text-right"></th>
                </tr>
              </thead>
              <tbody className="text-sm font-medium">
                {recentSessions.length > 0 ? recentSessions.map((session) => {
                  const presentCount = (session.attendance_records || []).filter((r: any) => r.status === 'Present').length;
                  const totalCount = (session.attendance_records || []).length;
                  
                  const isCompleted = session.date && new Date(session.date) < new Date();
                  const statusBg = isCompleted ? 'bg-tertiary-container' : 'bg-surface-container-high';
                  const statusText = isCompleted ? 'text-on-tertiary-container' : 'text-on-surface-variant';
                  const statusLabel = isCompleted ? 'Completed' : 'Pending';

                  const durationHrs = session.calculatedDurationMinutes ? (session.calculatedDurationMinutes / 60).toFixed(1) : '0';

                  const dateStr = session.date 
                    ? new Date(session.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'No Date';

                  return (
                    <tr key={session.id} className="hover:bg-surface-container-low transition-colors group">
                      <td className="py-5 pr-4">
                        <div className="flex flex-col">
                          <span>{dateStr}</span>
                          <span className="text-xs text-on-surface-variant">
                            {session.start_time ? session.start_time.substring(0,5) : '--:--'} - {session.end_time ? session.end_time.substring(0,5) : '--:--'}
                          </span>
                        </div>
                      </td>
                      <td className="py-5 pr-4">
                        <p className="font-bold text-on-surface mb-0.5">{session.courses?.name}</p>
                        <p className="text-xs text-on-surface-variant max-w-xs truncate" title={session.content || 'No content specified'}>
                          {session.content || 'No content specified'}
                        </p>
                      </td>
                      <td className="py-5 pr-4">
                        {totalCount > 0 ? `${presentCount} / ${totalCount}` : '-'}
                      </td>
                      <td className="py-5 pr-4">{durationHrs} hrs</td>
                      <td className="py-5 pr-4">
                        <span className={`${statusBg} ${statusText} px-3 py-1 rounded-full text-xs font-bold`}>
                          {statusLabel}
                        </span>
                      </td>
                      <td className="py-5 text-right">
                        <Link href={`/courses/${session.course_id}`}>
                          <span className="material-symbols-outlined text-outline hover:text-primary transition-colors cursor-pointer">arrow_forward_ios</span>
                        </Link>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-on-surface-variant">
                      No recent sessions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </main>
  );
}