import Link from 'next/link';
import {
  formatDurationHoursMinutes,
  normalizeGroupClassType,
  totalCourseDurationMinutes,
} from '@/lib/courseDuration';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import ScheduleTable from '@/components/ScheduleTable';

export const dynamic = 'force-dynamic';

export default async function CourseDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const id = resolvedParams.id;
  const supabase = getSupabaseAdmin();
  
  // Fetch course details with its group and teachers
  const { data: course } = await supabase
    .from('courses')
    .select(`
      id, 
      name,
      group_id,
      course_teachers (
        teachers ( name )
      )
    `)
    .eq('id', id)
    .single();

  if (!course) {
    return (
      <div className="pt-24 px-10 pb-12 text-center">
        <h2 className="text-2xl font-bold text-error mb-4">Course not found</h2>
        <Link href="/groups" className="text-primary mt-4 inline-flex items-center gap-2 hover:bg-primary/5 px-4 py-2 rounded-full transition-colors font-medium">
          <span className="material-symbols-outlined">arrow_back</span>
          Back to Groups
        </Link>
      </div>
    );
  }

  const groupQuery =
    course.group_id != null
      ? supabase.from('groups').select('name, class_type').eq('id', course.group_id).maybeSingle()
      : Promise.resolve({ data: null as { name: string; class_type: string | null } | null });

  const [{ count: studentCount }, { data: lessons }, { data: groupRow }] = await Promise.all([
    supabase.from('course_students').select('*', { count: 'exact', head: true }).eq('course_id', id),
    supabase
      .from('lessons')
      .select(`
      id,
      date,
      start_time,
      end_time,
      attendance_records (
        status
      )
    `)
      .eq('course_id', id)
      .order('date', { ascending: true }),
    groupQuery,
  ]);

  const group = groupRow ?? null;

  const teachers = course.course_teachers
    ?.map((ct: any) => ct.teachers?.name)
    .filter(Boolean)
    .join(', ') || 'No teachers assigned';

  const classType = normalizeGroupClassType(group?.class_type);
  const totalDurationMinutes = totalCourseDurationMinutes(lessons ?? [], classType);
  const totalDurationStr = formatDurationHoursMinutes(totalDurationMinutes);

  let totalAttendance = 0;
  let presentAttendance = 0;

  lessons?.forEach((lesson) => {
    lesson.attendance_records?.forEach((record: any) => {
      totalAttendance++;
      if (record.status === 'Present') presentAttendance++;
    });
  });

  const attendanceRate = totalAttendance > 0 ? Math.round((presentAttendance / totalAttendance) * 100) : 0;

  const validDates = lessons?.map(l => l.date).filter(Boolean) || [];
  validDates.sort(); // String sorting works for YYYY-MM-DD format
  const firstSessionDate = validDates.length > 0 ? new Date(validDates[0]).toLocaleDateString() : 'N/A';
  const lastSessionDate = validDates.length > 0 ? new Date(validDates[validDates.length - 1]).toLocaleDateString() : 'N/A';

  // We fetch lessons on the client side using the ScheduleTable, 
  // but we can pass down the course filter to it.
  
  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-8">
        <div className="flex gap-4 mb-6">
          <Link href={`/groups/${course.group_id}`} className="text-primary text-sm font-semibold inline-flex items-center gap-1 hover:bg-primary/5 px-3 py-1.5 -ml-3 rounded-full transition-colors">
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back to {group?.name || 'Group'}
          </Link>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-secondary-container/50 rounded-2xl flex items-center justify-center text-on-secondary-container">
            <span className="material-symbols-outlined text-3xl">class</span>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                {group?.name}
              </span>
            </div>
            <h2 className="text-4xl font-extrabold text-on-surface tracking-tight font-headline">
              {course.name}
            </h2>
            <p className="text-on-surface-variant mt-1 font-medium flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[18px]">person</span>
              {teachers}
            </p>
          </div>
        </div>
      </div>

      {/* HubSpot-like Analytics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-10">
        <div className="bg-surface-container-lowest p-5 rounded-2xl shadow-sm border border-outline-variant/10 flex flex-col justify-between group hover:translate-y-[-2px] transition-transform">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary text-xl bg-primary/10 p-1.5 rounded-lg">timer</span>
            <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Duration</span>
          </div>
          <div className="text-2xl font-black text-on-surface font-headline">{totalDurationStr}</div>
        </div>

        <div className="bg-surface-container-lowest p-5 rounded-2xl shadow-sm border border-outline-variant/10 flex flex-col justify-between group hover:translate-y-[-2px] transition-transform">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary text-xl bg-primary/10 p-1.5 rounded-lg">group</span>
            <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Students</span>
          </div>
          <div className="text-2xl font-black text-on-surface font-headline">{studentCount ?? 0}</div>
        </div>

        <div className="bg-surface-container-lowest p-5 rounded-2xl shadow-sm border border-outline-variant/10 flex flex-col justify-between group hover:translate-y-[-2px] transition-transform">
          <div className="flex justify-between items-start mb-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-tertiary text-xl bg-tertiary/10 p-1.5 rounded-lg">fact_check</span>
              <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Attendance</span>
            </div>
          </div>
          <div>
            <div className="text-2xl font-black text-on-surface font-headline">{attendanceRate}%</div>
            <div className="w-full h-1 bg-surface-container-highest rounded-full mt-2 overflow-hidden">
              <div className="h-full bg-tertiary" style={{ width: `${attendanceRate}%` }}></div>
            </div>
          </div>
        </div>

        <div className="bg-surface-container-lowest p-5 rounded-2xl shadow-sm border border-outline-variant/10 flex flex-col justify-between group hover:translate-y-[-2px] transition-transform">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-orange-500 text-xl bg-orange-500/10 p-1.5 rounded-lg">person</span>
            <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Teachers</span>
          </div>
          <div className="text-sm font-bold text-on-surface font-headline leading-tight line-clamp-2">{teachers}</div>
        </div>

        <div className="bg-surface-container-lowest p-5 rounded-2xl shadow-sm border border-outline-variant/10 flex flex-col justify-between group hover:translate-y-[-2px] transition-transform">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-secondary text-xl bg-secondary/10 p-1.5 rounded-lg">calendar_month</span>
            <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Timeline</span>
          </div>
          <div className="text-sm font-medium text-on-surface">
            <div className="flex items-center justify-between"><span className="text-on-surface-variant text-xs">First:</span> <span>{firstSessionDate}</span></div>
            <div className="flex items-center justify-between mt-1"><span className="text-on-surface-variant text-xs">Last:</span> <span>{lastSessionDate}</span></div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8">
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-bold text-xl text-on-surface">Schedule & Lessons</h3>
          </div>
          <ScheduleTable courseId={course.id} />
        </div>
      </div>
    </div>
  );
}
