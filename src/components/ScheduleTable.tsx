'use client';

import { useEffect, useState } from 'react';
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
  content: string;
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

export default function ScheduleTable({ courseId }: { courseId?: string } = {}) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [students, setStudents] = useState<Student[]>([]);

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

  const getAttendance = (lesson: Lesson, studentId: string): AttendanceRecord | undefined =>
    lesson.attendance_records?.find((r) => r.student_id === studentId);

  const totalCols = 3 + students.length;

  return (
    <div className="bg-surface-container-lowest rounded-[1rem] p-1 shadow-sm border border-outline-variant/5 overflow-hidden">
      <div className="overflow-x-auto no-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-surface-container-low/50">
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 sticky left-0 bg-surface-container-low/50 z-10">
                Kurs / Folien &amp; Inhalt
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
            {lessons.map((lesson) => (
              <tr key={lesson.id} className="hover:bg-surface-container-low transition-colors group">
                <td className="px-6 py-6 sticky left-0 bg-surface-container-lowest group-hover:bg-surface-container-low transition-colors z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-8 rounded-full group-hover:h-10 transition-all bg-secondary-container shrink-0"></div>
                    <div>
                      {(lesson.courses?.groups?.name || lesson.courses?.name) && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-primary block mb-0.5">
                          {[lesson.courses?.groups?.name, lesson.courses?.name].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      <span className="font-bold text-sm block">{lesson.slide_id}</span>
                      <span className="text-xs text-on-surface-variant block">{lesson.content}</span>
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
            ))}
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
