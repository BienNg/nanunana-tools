import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type CourseContext = { id: string; name: string; groupName: string | null };

export type FeedbackQueueCandidate = {
  id: string;
  name: string;
  feedbackSentAt: string | null;
  feedbackSnoozedUntil: string | null;
  feedbackDoneAt: string | null;
  dueByTime: boolean;
  absentSinceFeedbackCount: number;
  needsAttention: boolean;
  latestCourseFirstSessionDate: string | null;
  courses: CourseContext[];
};

function asSingle<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function toIsoDate(d: Date): string {
  return d.toISOString();
}

function minusDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Increment 2: read-only queue detection, no workflow actions yet. */
export async function getFeedbackQueueCandidates(nowArg?: Date): Promise<FeedbackQueueCandidate[]> {
  const supabase = getSupabaseAdmin();
  const now = nowArg ?? new Date();
  const lastMonthStart = minusDays(now, 30);
  const weekAgo = minusDays(now, 7);
  const IN_CHUNK_SIZE = 120;

  const { data: recentEnrollments, error: recentEnrollErr } = await supabase
    .from('course_students')
    .select('student_id')
    .gte('created_at', toIsoDate(lastMonthStart));

  if (recentEnrollErr) {
    console.error('getFeedbackQueueCandidates — recent enrollments', recentEnrollErr);
    return [];
  }

  const recentStudentIds = [...new Set((recentEnrollments ?? []).map((r) => String(r.student_id ?? '')))].filter(Boolean);
  if (recentStudentIds.length === 0) return [];

  const studentChunks = chunkArray(recentStudentIds, IN_CHUNK_SIZE);
  const studentRows: Array<{
    id: string;
    name: string;
    feedback_sent_at: string | null;
    feedback_snoozed_until: string | null;
    feedback_done_at: string | null;
  }> = [];
  const enrollmentRows: Array<{
    student_id: string;
    course_id: string;
    created_at: string;
    courses:
      | { id: string; name: string; groups: { name: string } | { name: string }[] | null }
      | { id: string; name: string; groups: { name: string } | { name: string }[] | null }[]
      | null;
  }> = [];
  const absenceRows: Array<{ student_id: string; created_at: string }> = [];

  for (const chunk of studentChunks) {
    const [studentsResult, enrollmentsResult, absencesResult] = await Promise.all([
      supabase
        .from('students')
        .select('id, name, feedback_sent_at, feedback_snoozed_until, feedback_done_at')
        .in('id', chunk),
      supabase
        .from('course_students')
        .select(
          `
          student_id,
          course_id,
          created_at,
          courses ( id, name, groups:groups!group_id ( name ) )
        `
        )
        .in('student_id', chunk),
      supabase
        .from('attendance_records')
        .select('student_id, status, created_at')
        .in('student_id', chunk)
        .eq('status', 'Absent'),
    ]);

    if (studentsResult.error) {
      console.error('getFeedbackQueueCandidates — students', studentsResult.error);
      return [];
    }
    if (enrollmentsResult.error) {
      console.error('getFeedbackQueueCandidates — enrollments', enrollmentsResult.error);
      return [];
    }
    if (absencesResult.error) {
      console.error('getFeedbackQueueCandidates — absences', absencesResult.error);
      return [];
    }

    studentRows.push(...((studentsResult.data ?? []) as typeof studentRows));
    enrollmentRows.push(...((enrollmentsResult.data ?? []) as typeof enrollmentRows));
    absenceRows.push(...((absencesResult.data ?? []) as Array<{ student_id: string; created_at: string }>));
  }

  const allEnrollments = enrollmentRows;

  const enrollmentsByStudent = new Map<string, typeof allEnrollments>();
  for (const row of allEnrollments) {
    const sid = String(row.student_id ?? '');
    if (!sid) continue;
    const list = enrollmentsByStudent.get(sid) ?? [];
    list.push(row);
    enrollmentsByStudent.set(sid, list);
  }

  const latestCourseByStudent = new Map<string, string>();
  for (const sid of recentStudentIds) {
    const rows = enrollmentsByStudent.get(sid) ?? [];
    if (rows.length === 0) continue;
    const latest = [...rows].sort((a, b) => {
      const ta = Date.parse(String(a.created_at ?? '')) || 0;
      const tb = Date.parse(String(b.created_at ?? '')) || 0;
      return tb - ta;
    })[0];
    if (latest?.course_id) latestCourseByStudent.set(sid, latest.course_id);
  }

  const latestCourseIds = [...new Set([...latestCourseByStudent.values()])];
  const firstSessionByCourseId = new Map<string, string>();
  if (latestCourseIds.length > 0) {
    const courseChunks = chunkArray(latestCourseIds, IN_CHUNK_SIZE);
    for (const chunk of courseChunks) {
      const { data: lessons, error: lessonsErr } = await supabase
        .from('lessons')
        .select('course_id, date')
        .in('course_id', chunk)
        .not('date', 'is', null);
      if (lessonsErr) {
        console.error('getFeedbackQueueCandidates — lessons', lessonsErr);
        return [];
      }
      for (const lesson of lessons ?? []) {
        const cid = String(lesson.course_id ?? '');
        const date = String(lesson.date ?? '');
        if (!cid || !date) continue;
        const existing = firstSessionByCourseId.get(cid);
        if (!existing || Date.parse(date) < Date.parse(existing)) {
          firstSessionByCourseId.set(cid, date);
        }
      }
    }
  }

  const absencesByStudent = new Map<string, string[]>();
  for (const row of absenceRows) {
    const sid = String(row.student_id ?? '');
    if (!sid) continue;
    const list = absencesByStudent.get(sid) ?? [];
    list.push(String(row.created_at ?? ''));
    absencesByStudent.set(sid, list);
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const candidates: FeedbackQueueCandidate[] = [];

  for (const student of studentRows) {
    const sid = String(student.id ?? '');
    if (!sid) continue;

    const latestCourseId = latestCourseByStudent.get(sid);
    const firstSessionDate = latestCourseId ? firstSessionByCourseId.get(latestCourseId) ?? null : null;

    if (firstSessionDate) {
      const firstSessionAt = new Date(`${firstSessionDate}T00:00:00.000Z`);
      const showAfter = new Date(firstSessionAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (now < showAfter) continue;
    }

    const feedbackSentAt = student.feedback_sent_at;
    const dueByTime = !feedbackSentAt || new Date(feedbackSentAt) < weekAgo;

    const absenceTimes = absencesByStudent.get(sid) ?? [];
    const absentSinceFeedbackCount = absenceTimes.filter((iso) => {
      if (!feedbackSentAt) return true;
      return Date.parse(iso) > Date.parse(feedbackSentAt);
    }).length;
    const needsAttention = absentSinceFeedbackCount > 1;

    if (!dueByTime && !needsAttention) continue;

    const coursesMap = new Map<string, CourseContext>();
    for (const row of enrollmentsByStudent.get(sid) ?? []) {
      const c = asSingle(row.courses);
      if (!c?.id) continue;
      const g = asSingle(c.groups);
      coursesMap.set(c.id, { id: c.id, name: c.name, groupName: g?.name ?? null });
    }
    const courses = [...coursesMap.values()].sort((a, b) => {
      const byName = collator.compare(a.name.trim(), b.name.trim());
      if (byName !== 0) return byName;
      return collator.compare((a.groupName ?? '').trim(), (b.groupName ?? '').trim());
    });

    candidates.push({
      id: sid,
      name: student.name,
      feedbackSentAt,
      feedbackSnoozedUntil: student.feedback_snoozed_until,
      feedbackDoneAt: student.feedback_done_at,
      dueByTime,
      absentSinceFeedbackCount,
      needsAttention,
      latestCourseFirstSessionDate: firstSessionDate,
      courses,
    });
  }

  return candidates.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    const aSent = a.feedbackSentAt ? Date.parse(a.feedbackSentAt) : 0;
    const bSent = b.feedbackSentAt ? Date.parse(b.feedbackSentAt) : 0;
    if (aSent !== bSent) return aSent - bSent;
    return collator.compare(a.name, b.name);
  });
}
