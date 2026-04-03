import Link from 'next/link';
import { getFeedbackQueueCandidates } from './feedbackStudents.server';
import FeedbackQueueViews from './FeedbackQueueViews';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const modeParam = params.mode;
  const rawMode = Array.isArray(modeParam) ? modeParam[0] : modeParam;
  const mode: 'focused' | 'list' = rawMode === 'list' ? 'list' : 'focused';

  const students = await getFeedbackQueueCandidates();
  const totalStudents = students.length;
  const needsAttentionCount = students.filter((s) => s.needsAttention).length;
  const dueInQueueCount = students.filter((s) => s.dueByTime).length;

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
          Feedback
        </h2>
        <p className="text-on-surface-variant max-w-2xl">
          Students with more than one absence since last feedback.
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
          <p className="text-xs uppercase tracking-wide text-blue-700">Due this week (in queue)</p>
          <p className="mt-1 text-2xl font-bold text-blue-800">{dueInQueueCount}</p>
        </div>
      </div>

      <div className="mb-3 text-sm text-slate-500">
        <p>
          {totalStudents === 0 ? 'No students in this view.' : `${totalStudents} student${totalStudents === 1 ? '' : 's'} in this view`}
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="inline-flex rounded-full bg-slate-100 p-1">
          <Link
            href="/feedback"
            className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
              mode === 'focused' ? 'bg-primary text-white' : 'text-slate-600 hover:bg-white'
            }`}
          >
            Focused
          </Link>
          <Link
            href="/feedback?mode=list"
            className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
              mode === 'list' ? 'bg-primary text-white' : 'text-slate-600 hover:bg-white'
            }`}
          >
            List
          </Link>
        </div>
      </div>

      <FeedbackQueueViews students={students} mode={mode} />

      {students.length > 0 ? (
        <p className="mt-4 text-sm text-slate-500">Sorted by priority: needs attention first, then oldest feedback date.</p>
      ) : null}
    </div>
  );
}
