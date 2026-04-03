import Link from 'next/link';
import { Fragment } from 'react';
import { getFeedbackQueueCandidates } from './feedbackStudents.server';
import { markStudentFeedbackDone } from '@/app/actions/markStudentFeedbackDone';
import { snoozeStudentFeedback, unsnoozeStudentFeedback } from '@/app/actions/snoozeStudentFeedback';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString();
}

function formatOptionalDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleDateString();
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const viewParam = params.view;
  const rawView = Array.isArray(viewParam) ? viewParam[0] : viewParam;
  const view: 'active' | 'snoozed' = rawView === 'snoozed' ? 'snoozed' : 'active';

  const students = await getFeedbackQueueCandidates(undefined, view);
  const needsAttentionCount = students.filter((s) => s.needsAttention).length;
  const dueOnlyCount = students.filter((s) => s.dueByTime && !s.needsAttention).length;

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
          Feedback
        </h2>
        <p className="text-on-surface-variant max-w-2xl">
          Students who are due for feedback this week or have more than one absence since last feedback.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Queue reason shows exactly why each student appears.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">In queue</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{students.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs uppercase tracking-wide text-amber-700">Needs attention</p>
          <p className="mt-1 text-2xl font-bold text-amber-800">{needsAttentionCount}</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs uppercase tracking-wide text-blue-700">Due this week</p>
          <p className="mt-1 text-2xl font-bold text-blue-800">{dueOnlyCount}</p>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/feedback"
          className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold ${
            view === 'active'
              ? 'bg-primary text-white'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          Active queue
        </Link>
        <Link
          href="/feedback?view=snoozed"
          className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold ${
            view === 'snoozed'
              ? 'bg-primary text-white'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          Snoozed
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Student
              </th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Courses
              </th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Missing since feedback
              </th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Last feedback
              </th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Snoozed until
              </th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Queue reason
              </th>
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((student) => (
              <tr key={student.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="py-4 px-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {student.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium text-slate-900">{student.name}</span>
                  </div>
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {student.courses.length === 0 ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <>
                      {student.courses.map((course, i) => (
                        <Fragment key={course.id}>
                          {i > 0 ? <span className="text-slate-300"> · </span> : null}
                          <Link
                            href={`/courses/${course.id}`}
                            className="text-primary font-medium underline-offset-2 hover:text-primary/80 hover:underline"
                          >
                            {course.groupName ? `${course.groupName} — ${course.name}` : course.name}
                          </Link>
                        </Fragment>
                      ))}
                    </>
                  )}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  <span className={student.needsAttention ? 'font-semibold text-error' : ''}>
                    {student.absentSinceFeedbackCount}
                  </span>
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {formatDate(student.feedbackSentAt)}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  {formatOptionalDate(student.feedbackSnoozedUntil)}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center gap-2">
                    {student.needsAttention ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                        Needs attention
                      </span>
                    ) : null}
                    {student.dueByTime ? (
                      <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800">
                        {student.dueDays === 9999 ? 'Due this week' : `Due (${student.dueDays}d)`}
                      </span>
                    ) : null}
                  </div>
                  {student.queueReasonDetails.length > 0 ? (
                    <p className="mt-1 text-xs text-slate-500">{student.queueReasonDetails.join(' | ')}</p>
                  ) : null}
                </td>
                <td className="py-4 px-6 text-sm text-slate-700">
                  <div className="flex items-center gap-2">
                    <form action={markStudentFeedbackDone.bind(null, student.id)}>
                      <button
                        type="submit"
                        className="inline-flex items-center rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                      >
                        Done
                      </button>
                    </form>
                    {view === 'active' ? (
                      <form action={snoozeStudentFeedback.bind(null, student.id, 7)}>
                        <button
                          type="submit"
                          className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Snooze 7d
                        </button>
                      </form>
                    ) : (
                      <form action={unsnoozeStudentFeedback.bind(null, student.id)}>
                        <button
                          type="submit"
                          className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Unsnooze
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={7} className="py-12 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center">
                    <span className="material-symbols-outlined mb-3 text-4xl text-slate-300">inbox</span>
                    <p>{view === 'snoozed' ? 'No snoozed students right now.' : 'No students are due for feedback right now.'}</p>
                    <p className="mt-1 text-sm text-slate-400">
                      {view === 'snoozed'
                        ? 'Snoozed students with active queue reasons appear here until their snooze expires.'
                        : 'Students appear after the first-week enrollment gate and queue rules are met.'}
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {students.length > 0 ? (
        <p className="mt-4 text-sm text-slate-500">Sorted by priority: needs attention first, then oldest feedback date.</p>
      ) : null}
    </div>
  );
}
