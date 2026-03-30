import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type TeacherRow = { id: string; name: string } | null;
type CourseTeacherRow = { teachers: TeacherRow | TeacherRow[] | null } | null;
type GroupRow = { id: string; name: string } | null;
type CourseRow = {
  id: string;
  name: string;
  groups: GroupRow | GroupRow[] | null;
  course_teachers: CourseTeacherRow[] | null;
} | null;
type CourseStudentRow = { courses: CourseRow } | null;
type StudentRow = {
  id: string;
  name: string;
  groups: GroupRow | GroupRow[] | null;
  course_students: CourseStudentRow[] | null;
};

type StudentSummary = {
  id: string;
  name: string;
  groups: string[];
  courses: string[];
  teachers: string[];
};

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export default async function StudentsPage() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('students')
    .select(`
      id,
      name,
      groups ( id, name ),
      course_students (
        courses (
          id,
          name,
          groups ( id, name ),
          course_teachers (
            teachers ( id, name )
          )
        )
      )
    `)
    .order('name');

  if (error) {
    console.error('Error fetching students:', error);
  }

  const studentRows = (data ?? []) as StudentRow[];
  const students: StudentSummary[] = studentRows.map((student) => {
    const groups = new Set<string>();
    const courses = new Set<string>();
    const teachers = new Set<string>();

    asArray(student.groups).forEach((group) => {
      if (group?.name) groups.add(group.name);
    });

    asArray(student.course_students).forEach((courseStudent) => {
      const course = courseStudent?.courses;
      if (!course) return;

      if (course.name) courses.add(course.name);
      asArray(course.groups).forEach((group) => {
        if (group?.name) groups.add(group.name);
      });

      asArray(course.course_teachers).forEach((courseTeacher) => {
        asArray(courseTeacher?.teachers).forEach((teacher) => {
          if (teacher?.name) teachers.add(teacher.name);
        });
      });
    });

    return {
      id: student.id,
      name: student.name,
      groups: [...groups].sort((a, b) => a.localeCompare(b)),
      courses: [...courses].sort((a, b) => a.localeCompare(b)),
      teachers: [...teachers].sort((a, b) => a.localeCompare(b)),
    };
  });

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
          Students
        </h2>
        <p className="text-on-surface-variant max-w-2xl">
          View each student with the courses they attend, groups they belong to, and the teachers assigned through those courses.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Student</th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Groups Attended</th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Courses Attended</th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Teachers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((student) => (
              <tr key={student.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="py-4 px-6">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                      {student.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium text-slate-900">{student.name}</span>
                  </div>
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {student.groups.length > 0 ? student.groups.join(', ') : 'No groups'}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {student.courses.length > 0 ? student.courses.join(', ') : 'No courses'}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {student.teachers.length > 0 ? student.teachers.join(', ') : 'No teachers'}
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={4} className="py-12 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center">
                    <span className="material-symbols-outlined text-4xl mb-3 text-slate-300">inbox</span>
                    <p>No students found. Import data to get started.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
