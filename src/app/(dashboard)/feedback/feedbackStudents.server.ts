import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type ActiveCourseRef = { id: string; name: string; groupName: string | null };

export type StudentInActiveCourses = {
  id: string;
  name: string;
  courses: ActiveCourseRef[];
};

function asSingle<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

/** Students with at least one enrollment in a course where `sync_completed` is false or null. */
export async function getStudentsInActiveCourses(): Promise<StudentInActiveCourses[]> {
  const supabase = getSupabaseAdmin();

  const { data: activeCourses, error: coursesErr } = await supabase
    .from('courses')
    .select('id')
    .or('sync_completed.is.false,sync_completed.is.null');

  if (coursesErr) {
    console.error('getStudentsInActiveCourses — active courses', coursesErr);
    return [];
  }

  const activeIds = (activeCourses ?? []).map((c) => c.id);
  if (activeIds.length === 0) return [];

  const { data, error } = await supabase
    .from('course_students')
    .select(
      `
      student_id,
      students ( id, name ),
      courses ( id, name, groups:groups!group_id ( name ) )
    `
    )
    .in('course_id', activeIds);

  if (error) {
    console.error('getStudentsInActiveCourses — course_students', error);
    return [];
  }

  const byStudent = new Map<string, { id: string; name: string; courses: Map<string, ActiveCourseRef> }>();

  for (const r of data ?? []) {
    const s = asSingle(r.students as { id: string; name: string } | { id: string; name: string }[] | null);
    const c = asSingle(
      r.courses as
        | { id: string; name: string; groups: { name: string } | { name: string }[] | null }
        | { id: string; name: string; groups: { name: string } | { name: string }[] | null }[]
        | null
    );
    if (!s?.id || !c?.id) continue;

    const g = c.groups;
    const groupRow = asSingle(g);
    const groupName = groupRow?.name ?? null;

    let entry = byStudent.get(s.id);
    if (!entry) {
      entry = { id: s.id, name: s.name, courses: new Map() };
      byStudent.set(s.id, entry);
    }
    if (!entry.courses.has(c.id)) {
      entry.courses.set(c.id, { id: c.id, name: c.name, groupName });
    }
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  return [...byStudent.values()]
    .map((e) => ({
      id: e.id,
      name: e.name,
      courses: [...e.courses.values()].sort((a, b) => {
        const byName = collator.compare(a.name.trim(), b.name.trim());
        if (byName !== 0) return byName;
        return collator.compare((a.groupName ?? '').trim(), (b.groupName ?? '').trim());
      }),
    }))
    .sort((a, b) => {
      const aCourse = a.courses[0]?.name.trim() ?? '';
      const bCourse = b.courses[0]?.name.trim() ?? '';
      const byCourse = collator.compare(aCourse, bCourse);
      if (byCourse !== 0) return byCourse;
      return collator.compare(a.name.trim(), b.name.trim());
    });
}
