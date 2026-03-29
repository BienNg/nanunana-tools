import Link from 'next/link';
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
      groups ( name ),
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

  const teachers = course.course_teachers
    ?.map((ct: any) => ct.teachers?.name)
    .filter(Boolean)
    .join(', ') || 'No teachers assigned';

  // We fetch lessons on the client side using the ScheduleTable, 
  // but we can pass down the course filter to it.
  
  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <div className="flex gap-4 mb-6">
          <Link href={`/groups/${course.group_id}`} className="text-primary text-sm font-semibold inline-flex items-center gap-1 hover:bg-primary/5 px-3 py-1.5 -ml-3 rounded-full transition-colors">
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back to {course.groups?.name || 'Group'}
          </Link>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-secondary-container/50 rounded-2xl flex items-center justify-center text-on-secondary-container">
            <span className="material-symbols-outlined text-3xl">class</span>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                {course.groups?.name}
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
