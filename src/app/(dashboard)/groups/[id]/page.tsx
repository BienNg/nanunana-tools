import { Fragment } from 'react';
import Link from 'next/link';
import { SyncCompletionPill } from '@/components/SyncCompletionPill';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function GroupDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const id = resolvedParams.id;
  const supabase = getSupabaseAdmin();
  
  // Fetch group details
  const { data: group } = await supabase
    .from('groups')
    .select('id, name, sync_completed')
    .eq('id', id)
    .single();

  // Fetch courses in this group
  const { data: courses } = await supabase
    .from('courses')
    .select(`
      id,
      name,
      sync_completed,
      course_teachers (
        teachers ( id, name )
      )
    `)
    .eq('group_id', id)
    .order('name');

  if (!group) {
    return (
      <div className="pt-24 px-10 pb-12 text-center">
        <h2 className="text-2xl font-bold text-error mb-4">Group not found</h2>
        <Link href="/groups" className="text-primary mt-4 inline-flex items-center gap-2 hover:bg-primary/5 px-4 py-2 rounded-full transition-colors font-medium">
          <span className="material-symbols-outlined">arrow_back</span>
          Back to Groups
        </Link>
      </div>
    );
  }

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <Link href="/groups" className="text-primary text-sm font-semibold inline-flex items-center gap-1 mb-6 hover:bg-primary/5 px-3 py-1.5 -ml-3 rounded-full transition-colors">
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          Back to Groups
        </Link>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-3xl">workspaces</span>
          </div>
          <div>
            <h2 className="text-4xl font-extrabold text-on-surface tracking-tight font-headline">
              {group.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-on-surface-variant font-medium">
                {courses?.length || 0} {(courses?.length === 1) ? 'Course' : 'Courses'}
              </p>
              <SyncCompletionPill completed={group.sync_completed ?? false} />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-6 py-5 border-b border-outline-variant/10 bg-surface-container-low/30 flex justify-between items-center">
          <h3 className="font-bold text-lg text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">book</span>
            Courses in {group.name}
          </h3>
        </div>
        <div className="divide-y divide-outline-variant/10">
          {courses?.map((course) => {
            const teacherList =
              course.course_teachers
                ?.map((ct: any) => ct.teachers as { id: string; name: string } | null | undefined)
                .filter((t): t is { id: string; name: string } => Boolean(t?.id && t?.name)) ?? [];

            return (
              <div
                key={course.id}
                className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-surface-container-low/30 transition-colors group"
              >
                <div className="flex items-start gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shrink-0 mt-1">
                    <span className="material-symbols-outlined text-[20px]">class</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <Link
                        href={`/courses/${course.id}`}
                        className="font-bold text-on-surface text-lg hover:text-primary transition-colors"
                      >
                        {course.name}
                      </Link>
                      <SyncCompletionPill completed={course.sync_completed ?? false} />
                    </div>
                    <p className="text-sm text-on-surface-variant flex flex-wrap items-center gap-x-1 gap-y-0.5 font-medium">
                      <span className="material-symbols-outlined text-[16px] shrink-0">person</span>
                      {teacherList.length === 0 ? (
                        <span>No teachers assigned</span>
                      ) : (
                        teacherList.map((teacher, index) => (
                          <Fragment key={teacher.id}>
                            {index > 0 ? ', ' : null}
                            <Link
                              href={`/teachers/${teacher.id}`}
                              className="text-primary hover:underline underline-offset-2"
                            >
                              {teacher.name}
                            </Link>
                          </Fragment>
                        ))
                      )}
                    </p>
                  </div>
                </div>
                <Link
                  href={`/courses/${course.id}`}
                  className="text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0 self-end sm:self-center p-1 -m-1 rounded-full hover:bg-primary/5"
                  aria-label={`Open course ${course.name}, ${course.sync_completed ? 'import completed' : 'import not completed'}`}
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </Link>
              </div>
            );
          })}
          {(!courses || courses.length === 0) && (
            <div className="p-16 text-center flex flex-col items-center justify-center">
              <span className="material-symbols-outlined text-4xl text-outline mb-3">folder_open</span>
              <p className="text-on-surface-variant font-medium">No courses found for this group.</p>
              <p className="text-sm text-outline mt-1">Courses will appear here once they are imported.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
