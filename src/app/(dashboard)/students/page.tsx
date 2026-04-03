import Link from 'next/link';
import { Fragment, Suspense, type ReactNode } from 'react';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import StudentAliasesManager from '@/components/StudentAliasesManager';
import StudentsFilters from '@/components/StudentsFilters';

export const dynamic = 'force-dynamic';
const STUDENTS_PER_PAGE = 50;

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

type SearchParams = Record<string, string | string[] | undefined>;

type StudentsPageProps = {
  searchParams: Promise<SearchParams>;
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

/** Group ids for a student row (direct group + groups via courses), aligned with StudentSummary.groups. */
type StudentOptionRow = Pick<StudentRow, 'id' | 'name' | 'groups' | 'course_students'>;

function collectStudentGroupIds(row: StudentOptionRow): string[] {
  const ids = new Set<string>();
  asArray(row.groups).forEach((g) => {
    if (g?.id) ids.add(g.id);
  });
  asArray(row.course_students).forEach((courseStudent) => {
    asArray(courseStudent?.courses).forEach((course) => {
      if (!course) return;
      asArray(course.groups).forEach((g) => {
        if (g?.id) ids.add(g.id);
      });
    });
  });
  return [...ids];
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function buildStudentsUrl({
  page,
  query,
  group,
}: {
  page: number;
  query: string;
  group: string;
}): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (group) params.set('group', group);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/students?${qs}` : '/students';
}

export default async function StudentsPage({ searchParams }: StudentsPageProps) {
  const resolvedSearchParams = await searchParams;
  const queryText = firstParam(resolvedSearchParams.q).trim();
  const groupFilter = firstParam(resolvedSearchParams.group).trim();
  const pageParam = Number.parseInt(firstParam(resolvedSearchParams.page), 10);
  const currentPage = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const rangeFrom = (currentPage - 1) * STUDENTS_PER_PAGE;
  const rangeTo = rangeFrom + STUDENTS_PER_PAGE - 1;

  const supabase = getSupabaseAdmin();
  let studentsQuery = supabase
    .from('students')
    .select(`
      id,
      group_id,
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
    `, { count: 'exact' })
    .order('name');

  if (queryText) {
    const searchKey = normalizePersonNameKey(queryText);
    if (searchKey) {
      studentsQuery = studentsQuery.ilike('name_search_key', `%${searchKey}%`);
    } else {
      studentsQuery = studentsQuery.ilike('name', `%${queryText}%`);
    }
  }

  if (groupFilter) {
    studentsQuery = studentsQuery.eq('group_id', groupFilter);
  }

  const [studentsResponse, groupsResponse, studentOptionsResponse] = await Promise.all([
    studentsQuery.range(rangeFrom, rangeTo),
    supabase.from('groups').select('id, name').order('name'),
    supabase
      .from('students')
      .select(`
        id,
        name,
        groups ( id ),
        course_students (
          courses (
            groups ( id )
          )
        )
      `)
      .order('name'),
  ]);

  if (studentsResponse.error) {
    console.error('Error fetching students:', studentsResponse.error);
  }
  if (groupsResponse.error) {
    console.error('Error fetching groups:', groupsResponse.error);
  }
  if (studentOptionsResponse.error) {
    console.error('Error fetching student options:', studentOptionsResponse.error);
  }

  const totalStudents = studentsResponse.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalStudents / STUDENTS_PER_PAGE));
  const hasPreviousPage = currentPage > 1;
  const hasNextPage = currentPage < totalPages;
  const pagesToRender = Array.from({ length: totalPages }, (_, idx) => idx + 1).filter(
    (page) => Math.abs(page - currentPage) <= 2 || page === 1 || page === totalPages
  );

  const uniquePagesToRender = pagesToRender.filter(
    (page, index) => pagesToRender.indexOf(page) === index
  );

  const gapsBeforePage = (page: number): boolean => {
    const idx = uniquePagesToRender.indexOf(page);
    if (idx <= 0) return false;
    return page - uniquePagesToRender[idx - 1] > 1;
  };

  const studentRows = (studentsResponse.data ?? []) as StudentRow[];
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
  const pageStart = students.length === 0 ? 0 : rangeFrom + 1;
  const pageEnd = students.length === 0 ? 0 : Math.min(rangeTo + 1, totalStudents);

  const studentOptions = ((studentOptionsResponse.data ?? []) as StudentOptionRow[])
    .map((s) => ({
      id: s.id,
      name: s.name,
      groupIds: collectStudentGroupIds(s),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = ((groupsResponse.data ?? []) as Array<{ id: string; name: string }>)
    .map((group) => ({ id: group.id, name: group.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const activeFilters = Boolean(queryText || groupFilter);

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

      <Suspense
        fallback={
          <div
            className="mb-5 h-[88px] animate-pulse rounded-xl border border-slate-200 bg-white"
            aria-hidden
          />
        }
      >
        <StudentsFilters groups={groups} />
      </Suspense>

      <div className="mb-3 flex items-center justify-between text-sm text-slate-500">
        <p>
          Showing {pageStart}-{pageEnd} of {totalStudents} students
        </p>
        <p>{STUDENTS_PER_PAGE} per page</p>
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
                    currentStudentGroupIds={student.groups.map((g) => g.id)}
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
                    <p>
                      {activeFilters
                        ? 'No students match your filters.'
                        : 'No students found. Import data to get started.'}
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link
          href={buildStudentsUrl({ page: Math.max(1, currentPage - 1), query: queryText, group: groupFilter })}
          aria-disabled={!hasPreviousPage}
          className={`inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition ${
            hasPreviousPage
              ? 'border-slate-200 text-slate-700 hover:bg-slate-50'
              : 'pointer-events-none border-slate-100 text-slate-300'
          }`}
        >
          Previous
        </Link>

        {uniquePagesToRender.map((page) => (
          <Fragment key={page}>
            {gapsBeforePage(page) ? (
              <span className="px-1 text-slate-400" aria-hidden="true">
                ...
              </span>
            ) : null}
            <Link
              href={buildStudentsUrl({ page, query: queryText, group: groupFilter })}
              aria-current={currentPage === page ? 'page' : undefined}
              className={`inline-flex h-9 min-w-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition ${
                currentPage === page
                  ? 'border-primary bg-primary text-white'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {page}
            </Link>
          </Fragment>
        ))}

        <Link
          href={buildStudentsUrl({ page: Math.min(totalPages, currentPage + 1), query: queryText, group: groupFilter })}
          aria-disabled={!hasNextPage}
          className={`inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition ${
            hasNextPage
              ? 'border-slate-200 text-slate-700 hover:bg-slate-50'
              : 'pointer-events-none border-slate-100 text-slate-300'
          }`}
        >
          Next
        </Link>
      </div>
    </div>
  );
}
