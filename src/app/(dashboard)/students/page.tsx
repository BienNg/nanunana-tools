import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import StudentAliasesManager from '@/components/StudentAliasesManager';

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
/** Supabase nested select returns `courses` as an array for the course_students → courses relation. */
type CourseStudentRow = {
  courses: NonNullable<CourseRow> | NonNullable<CourseRow>[] | null;
} | null;
type StudentRow = {
  id: string;
  name: string;
  groups: GroupRow | GroupRow[] | null;
  course_students: CourseStudentRow[] | null;
  student_aliases: StudentAliasRow[] | null;
};
type StudentAliasRow = { id: string; alias: string } | null;

type NamedEntity = { id: string; name: string };

type StudentSummary = {
  id: string;
  name: string;
  groups: NamedEntity[];
  courses: NamedEntity[];
  teachers: NamedEntity[];
  aliases: { id: string; alias: string }[];
};

function addById(map: Map<string, NamedEntity>, entity: NamedEntity | null | undefined): void {
  if (entity?.id && entity?.name) map.set(entity.id, { id: entity.id, name: entity.name });
}

function sortedNamedEntities(map: Map<string, NamedEntity>): NamedEntity[] {
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function entityLinks(
  items: NamedEntity[],
  href: (id: string) => string,
  emptyLabel: string
): ReactNode {
  if (items.length === 0) return emptyLabel;
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={item.id}>
          {i > 0 ? ', ' : null}
          <Link
            href={href(item.id)}
            className="text-primary font-medium underline-offset-2 hover:text-primary/80 hover:underline"
          >
            {item.name}
          </Link>
        </Fragment>
      ))}
    </>
  );
}

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
      student_aliases ( id, alias ),
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
    const groupsMap = new Map<string, NamedEntity>();
    const coursesMap = new Map<string, NamedEntity>();
    const teachersMap = new Map<string, NamedEntity>();

    asArray(student.groups).forEach((group) => {
      addById(groupsMap, group);
    });

    asArray(student.course_students).forEach((courseStudent) => {
      asArray(courseStudent?.courses).forEach((course) => {
        if (!course) return;

        addById(coursesMap, course);
        asArray(course.groups).forEach((group) => {
          addById(groupsMap, group);
        });

        asArray(course.course_teachers).forEach((courseTeacher) => {
          asArray(courseTeacher?.teachers).forEach((teacher) => {
            addById(teachersMap, teacher);
          });
        });
      });
    });

    return {
      id: student.id,
      name: student.name,
      groups: sortedNamedEntities(groupsMap),
      courses: sortedNamedEntities(coursesMap),
      teachers: sortedNamedEntities(teachersMap),
      aliases: asArray(student.student_aliases)
        .filter((alias): alias is NonNullable<StudentAliasRow> => Boolean(alias?.id && alias?.alias))
        .sort((a, b) => a.alias.localeCompare(b.alias)),
    };
  });
  const studentOptions = students
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Aliases</th>
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
                  {entityLinks(student.groups, (id) => `/groups/${id}`, 'No groups')}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {entityLinks(student.courses, (id) => `/courses/${id}`, 'No courses')}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {entityLinks(student.teachers, (id) => `/teachers/${id}`, 'No teachers')}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  <StudentAliasesManager
                    studentId={student.id}
                    studentName={student.name}
                    aliases={student.aliases}
                    studentOptions={studentOptions}
                  />
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-500">
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
