import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type CourseContext = { id: string; name: string; groupName: string | null };

export type FeedbackQueueCandidate = {
  id: string;
  name: string;
  feedbackSentAt: string | null;
  feedbackSnoozedUntil: string | null;
  feedbackDoneAt: string | null;
  dueByTime: boolean;
  dueDays: number;
  absentSinceFeedbackCount: number;
  needsAttention: boolean;
  queueReasonDetails: string[];
  latestCourseFirstSessionDate: string | null;
  courses: CourseContext[];
};

type QueueView = 'active' | 'snoozed';
export type FeedbackQueueView = QueueView;

export type FeedbackQueuePage = {
  items: FeedbackQueueCandidate[];
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  totalNeedsAttention: number;
  totalDueOnly: number;
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

function wholeDaysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Increment 2: read-only queue detection, no workflow actions yet. */
export async function getFeedbackQueueCandidates(
  nowArg?: Date,
  view: QueueView = 'active'
): Promise<FeedbackQueueCandidate[]> {
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
  const latestEnrollmentTsByStudent = new Map<string, number>();
  for (const row of allEnrollments) {
    const sid = String(row.student_id ?? '');
    const cid = String(row.course_id ?? '');
    if (!sid || !cid) continue;
    const ts = Date.parse(String(row.created_at ?? '')) || 0;
    const prev = latestEnrollmentTsByStudent.get(sid);
    if (prev == null || ts > prev) {
      latestEnrollmentTsByStudent.set(sid, ts);
      latestCourseByStudent.set(sid, cid);
    }
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
    const feedbackSentAtDate = feedbackSentAt ? new Date(feedbackSentAt) : null;
    const dueByTime = !feedbackSentAtDate || feedbackSentAtDate < weekAgo;
    const dueDays = !feedbackSentAtDate ? 9999 : Math.max(0, wholeDaysBetween(feedbackSentAtDate, now));
    const snoozedUntil = student.feedback_snoozed_until;
    const isCurrentlySnoozed =
      Boolean(snoozedUntil) && Date.parse(String(snoozedUntil)) > now.getTime();

    const absenceTimes = absencesByStudent.get(sid) ?? [];
    const absentSinceFeedbackCount = absenceTimes.filter((iso) => {
      if (!feedbackSentAt) return true;
      return Date.parse(iso) > Date.parse(feedbackSentAt);
    }).length;
    const needsAttention = absentSinceFeedbackCount > 1;
    const queueReasonDetails: string[] = [];
    if (needsAttention) {
      queueReasonDetails.push(`${absentSinceFeedbackCount} absences since last feedback`);
    }
    if (dueByTime) {
      queueReasonDetails.push(
        !feedbackSentAtDate ? 'No feedback sent yet' : `${dueDays} days since last feedback`
      );
    }

    // Product rule: only detect students with more than one absence since feedback.
    if (!needsAttention) continue;
    if (view === 'active' && isCurrentlySnoozed) continue;
    if (view === 'snoozed' && !isCurrentlySnoozed) continue;

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
      feedbackSnoozedUntil: snoozedUntil,
      feedbackDoneAt: student.feedback_done_at,
      dueByTime,
      dueDays,
      absentSinceFeedbackCount,
      needsAttention,
      queueReasonDetails,
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

export async function getFeedbackQueueCandidatesPage(args?: {
  nowArg?: Date;
  view?: QueueView;
  page?: number;
  pageSize?: number;
}): Promise<FeedbackQueuePage> {
  const view = args?.view ?? 'active';
  const pageSize = Number.isFinite(args?.pageSize)
    ? Math.max(1, Math.floor(args?.pageSize as number))
    : 25;
  const requestedPage = Number.isFinite(args?.page) ? Math.max(1, Math.floor(args?.page as number)) : 1;
  const all = await getFeedbackQueueCandidates(args?.nowArg, view);
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const items = all.slice(start, end);
  const totalNeedsAttention = all.filter((s) => s.needsAttention).length;
  const totalDueOnly = all.filter((s) => s.dueByTime && !s.needsAttention).length;

  return {
    items,
    total,
    totalPages,
    page,
    pageSize,
    totalNeedsAttention,
    totalDueOnly,
  };
}
