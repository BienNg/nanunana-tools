'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { localDateISO } from '@/lib/localDate';
import { supabase } from '@/lib/supabase/client';
import { SyncCompletionPill } from '@/components/SyncCompletionPill';

type Teacher = { id: string; name: string };

type ActiveCourseRow = {
  id: string;
  name: string;
  sync_completed: boolean;
  group_id: string | null;
  groups: { id: string; name: string } | null;
  course_teachers: { teachers: Teacher | null }[] | null;
};

function sortActiveCourses(a: ActiveCourseRow, b: ActiveCourseRow): number {
  const ga = a.groups?.name ?? '\uffff';
  const gb = b.groups?.name ?? '\uffff';
  const byGroup = ga.localeCompare(gb);
  if (byGroup !== 0) return byGroup;
  return a.name.localeCompare(b.name);
}

export default function ActiveCoursesPanel() {
  const [courses, setCourses] = useState<ActiveCourseRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const today = localDateISO();
    const { data: pendingLessons, error: lessonsErr } = await supabase
      .from('lessons')
      .select('course_id')
      .gte('date', today);

    if (lessonsErr) {
      console.error('Active courses — lessons', lessonsErr.message ?? lessonsErr);
      setCourses([]);
      setLoading(false);
      return;
    }

    const ids = [...new Set((pendingLessons ?? []).map((l) => l.course_id).filter(Boolean))];

    if (ids.length === 0) {
      setCourses([]);
      setLoading(false);
      return;
    }

    const { data: rows, error: coursesErr } = await supabase
      .from('courses')
      .select(
        `
        id,
        name,
        sync_completed,
        group_id,
        groups ( id, name ),
        course_teachers (
          teachers ( id, name )
        )
      `
      )
      .in('id', ids);

    if (coursesErr) {
      console.error('Active courses — courses', coursesErr);
      setCourses([]);
      setLoading(false);
      return;
    }

    const raw = (rows ?? []) as unknown as Array<{
      id: string;
      name: string;
      sync_completed: boolean;
      group_id: string | null;
      groups: { id: string; name: string } | { id: string; name: string }[] | null;
      course_teachers: ActiveCourseRow['course_teachers'];
    }>;

    const normalized: ActiveCourseRow[] = raw.map((row) => ({
      ...row,
      groups: Array.isArray(row.groups) ? row.groups[0] ?? null : row.groups ?? null,
    }));

    setCourses([...normalized].sort(sortActiveCourses));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();

    const channel = supabase
      .channel('active-courses-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons' }, () => {
        void refresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, () => {
        void refresh();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refresh]);

  return (
    <div className="animate-fade-up rounded-2xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-outline-variant/10 bg-surface-container-low/30 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="font-bold text-lg text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">pending_actions</span>
            Active courses
          </h3>
          <p className="text-sm text-on-surface-variant mt-0.5">
            Courses with at least one lesson scheduled today or later (local date).
          </p>
        </div>
        {!loading ? (
          <span className="shrink-0 text-sm font-bold text-on-surface-variant tabular-nums">
            {courses.length} {courses.length === 1 ? 'course' : 'courses'}
          </span>
        ) : null}
      </div>

      <div className="divide-y divide-outline-variant/10">
        {loading ? (
          <div className="p-12 text-center text-on-surface-variant font-medium">Loading…</div>
        ) : courses.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center justify-center">
            <span className="material-symbols-outlined text-4xl text-outline mb-3">check_circle</span>
            <p className="text-on-surface-variant font-medium">No active courses.</p>
            <p className="text-sm text-outline mt-1">
              No lessons dated today or later, or no dated lessons in the database yet.
            </p>
          </div>
        ) : (
          courses.map((course) => {
            const teacherList =
              course.course_teachers
                ?.map((ct) => ct.teachers)
                .filter((t): t is Teacher => Boolean(t?.id && t?.name)) ?? [];

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
                    <p className="text-sm text-on-surface-variant flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
                      {course.groups ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-[16px] shrink-0">workspaces</span>
                          <Link
                            href={`/groups/${course.groups.id}`}
                            className="text-primary hover:underline underline-offset-2"
                          >
                            {course.groups.name}
                          </Link>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-outline">
                          <span className="material-symbols-outlined text-[16px] shrink-0">workspaces</span>
                          No group
                        </span>
                      )}
                      <span className="text-outline hidden sm:inline">·</span>
                      <span className="inline-flex items-center gap-1 min-w-0">
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
                      </span>
                    </p>
                  </div>
                </div>
                <Link
                  href={`/courses/${course.id}`}
                  className="text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0 self-end sm:self-center p-1 -m-1 rounded-full hover:bg-primary/5"
                  aria-label={`Open course ${course.name}`}
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </Link>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
