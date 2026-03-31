'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

type AttendanceRecord = {
  id: string;
  student_id: string;
  status: string;
  feedback: string | null;
};

type Lesson = {
  id: string;
  slide_id: string;
  date: string;
  start_time: string;
  end_time: string;
  teacher: string;
  courses: {
    name: string;
    groups: { name: string } | null;
  } | null;
  attendance_records: AttendanceRecord[];
};

type Student = {
  id: string;
  name: string;
};

function lessonCourseLabel(lesson: Lesson): string {
  return [lesson.courses?.groups?.name, lesson.courses?.name].filter(Boolean).join(' · ');
}

function compareLessonsByCourseColumn(a: Lesson, b: Lesson): number {
  const labelCmp = lessonCourseLabel(a).localeCompare(lessonCourseLabel(b), undefined, { sensitivity: 'base' });
  if (labelCmp !== 0) return labelCmp;
  const slideCmp = a.slide_id.localeCompare(b.slide_id, undefined, { numeric: true, sensitivity: 'base' });
  if (slideCmp !== 0) return slideCmp;
  return a.id.localeCompare(b.id);
}

export default function ScheduleTable({ courseId }: { courseId?: string } = {}) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [openLessonActionId, setOpenLessonActionId] = useState<string | null>(null);
  const [deletingLessonId, setDeletingLessonId] = useState<string | null>(null);

  const fetchData = async () => {
    let query = supabase
      .from('lessons')
      .select(
        `*,
        courses (
          name,
          groups ( name )
        ),
        attendance_records (
          id,
          student_id,
          status,
          feedback
        )`
      );

    if (courseId) {
      query = query.eq('course_id', courseId);
    }

    const { data: lessonsData } = await query
      .order('date', { ascending: true })
      .order('start_time', { ascending: true });

    if (lessonsData) setLessons(lessonsData as Lesson[]);

    if (courseId) {
      const { data: enrollments } = await supabase
        .from('course_students')
        .select('students ( id, name )')
        .eq('course_id', courseId);

      const rows: Student[] = [];
      for (const row of enrollments ?? []) {
        const s = row.students as Student | Student[] | null | undefined;
        if (s == null) continue;
        const list = Array.isArray(s) ? s : [s];
        for (const st of list) {
          if (st?.id && st?.name) rows.push(st);
        }
      }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      setStudents(rows);
    }
  };

  useEffect(() => {
    fetchData();

    const channel = supabase
      .channel(`schedule-${courseId || 'all'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons', filter: courseId ? `course_id=eq.${courseId}` : undefined }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, fetchData)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'course_students',
          filter: courseId ? `course_id=eq.${courseId}` : undefined,
        },
        fetchData
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, fetchData)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [courseId]);

  useEffect(() => {
    const closeMenu = () => setOpenLessonActionId(null);
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, []);

  const getAttendance = (lesson: Lesson, studentId: string): AttendanceRecord | undefined =>
    lesson.attendance_records?.find((r) => r.student_id === studentId);

  const sortedLessons = useMemo(() => [...lessons].sort(compareLessonsByCourseColumn), [lessons]);

  const totalCols = 3 + students.length;

  const deleteLesson = async (lesson: Lesson) => {
    const confirmed = window.confirm(
      `Delete this session?\n\n${lessonCourseLabel(lesson)} ${lesson.slide_id}\n${lesson.date || 'TBA'} ${lesson.start_time?.slice(0, 5) || ''}`.trim()
    );
    if (!confirmed) return;

    setDeletingLessonId(lesson.id);
    setOpenLessonActionId(null);

    const { error: attendanceDeleteError } = await supabase.from('attendance_records').delete().eq('lesson_id', lesson.id);
    if (attendanceDeleteError) {
      window.alert(`Could not delete attendance records: ${attendanceDeleteError.message}`);
      setDeletingLessonId(null);
      return;
    }

    const { error: lessonDeleteError } = await supabase.from('lessons').delete().eq('id', lesson.id);
    if (lessonDeleteError) {
      window.alert(`Could not delete session: ${lessonDeleteError.message}`);
      setDeletingLessonId(null);
      return;
    }

    setDeletingLessonId(null);
    fetchData();
  };

  return (
    <div className="bg-surface-container-lowest rounded-[1rem] p-1 shadow-sm border border-outline-variant/5 overflow-hidden">
      <div className="overflow-x-auto no-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-surface-container-low/50">
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 sticky left-0 bg-surface-container-low/50 z-10">
                Kurs / Folien
              </th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 whitespace-nowrap">
                Datum &amp; Zeit
              </th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
                Lehrer
              </th>
              {students.map((student) => (
                <th
                  key={student.id}
                  className="px-4 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 text-center min-w-[130px] whitespace-nowrap"
                >
                  {student.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/10">
            {sortedLessons.map((lesson) => {
              const courseLabel = lessonCourseLabel(lesson);
              return (
                <tr key={lesson.id} className="hover:bg-surface-container-low transition-colors group">
                <td className="px-6 py-6 sticky left-0 bg-surface-container-lowest group-hover:bg-surface-container-low transition-colors z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-8 rounded-full group-hover:h-10 transition-all bg-secondary-container shrink-0"></div>
                    <div className="min-w-0 flex-1">
                      {courseLabel && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-primary block mb-0.5">
                          {courseLabel}
                        </span>
                      )}
                      <span className="font-bold text-sm block">{lesson.slide_id}</span>
                    </div>
                    <div className="relative">
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={openLessonActionId === lesson.id}
                        aria-label={`Session actions for ${lesson.slide_id}`}
                        disabled={deletingLessonId === lesson.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenLessonActionId((prev) => (prev === lesson.id ? null : lesson.id));
                        }}
                        className="inline-flex items-center justify-center rounded-md border border-outline-variant/30 bg-surface-container-lowest p-1 text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-base leading-none">more_vert</span>
                      </button>
                      {openLessonActionId === lesson.id && (
                        <div
                          role="menu"
                          onClick={(event) => event.stopPropagation()}
                          className="absolute right-0 top-[calc(100%+0.25rem)] z-30 min-w-[9.5rem] rounded-md border border-outline-variant/20 bg-surface-container-lowest p-1 shadow-lg"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            disabled={deletingLessonId === lesson.id}
                            onClick={() => deleteLesson(lesson)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-semibold text-error hover:bg-error/10 disabled:opacity-50"
                          >
                            <span className="material-symbols-outlined text-sm leading-none">delete</span>
                            {deletingLessonId === lesson.id ? 'Deleting...' : 'Delete session'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-6 text-sm whitespace-nowrap">
                  <div className="font-medium">{lesson.date ? new Date(lesson.date).toLocaleDateString() : 'TBA'}</div>
                  {lesson.start_time && (
                    <div className="text-xs text-on-surface-variant">
                      <span className="text-on-surface font-bold">{lesson.start_time.slice(0, 5)}</span>
                      <span className="text-outline mx-1">-</span>
                      <span className="text-on-surface font-bold">{lesson.end_time?.slice(0, 5) || '?'}</span>
                    </div>
                  )}
                </td>
                <td className="px-6 py-6 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-[10px] font-bold text-blue-700 shrink-0">
                      {lesson.teacher?.substring(0, 2).toUpperCase() || 'TBA'}
                    </div>
                    <span className="text-sm font-semibold">{lesson.teacher || 'TBA'}</span>
                  </div>
                </td>
                {students.map((student) => {
                  const record = getAttendance(lesson, student.id);
                  const isPresent = record?.status === 'Present';
                  const isAbsent = record?.status === 'Absent';

                  const cellClass =
                    record && isPresent
                      ? 'bg-green-100 group-hover:bg-green-200/85'
                      : record && isAbsent
                        ? 'bg-red-100 group-hover:bg-red-200/85'
                        : '';

                  return (
                    <td
                      key={student.id}
                      title={record ? record.status : undefined}
                      className={`px-4 py-6 text-center align-top transition-colors ${cellClass}`}
                    >
                      {record ? (
                        record.feedback ? (
                          <p
                            className="text-[10px] text-on-surface-variant leading-tight max-w-[110px] mx-auto text-center line-clamp-3"
                            title={record.feedback}
                          >
                            {record.feedback}
                          </p>
                        ) : null
                      ) : (
                        <span className="text-outline/30 text-base leading-none">—</span>
                      )}
                    </td>
                  );
                })}
                </tr>
              );
            })}
            {lessons.length === 0 && (
              <tr>
                <td colSpan={totalCols} className="px-6 py-12 text-center text-on-surface-variant">
                  No schedule data available. Import a Google Sheet to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
