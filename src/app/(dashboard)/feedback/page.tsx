import Link from 'next/link';
import { getFeedbackQueueCandidatesPage, type FeedbackQueueView } from './feedbackStudents.server';
import FeedbackQueueViews from './FeedbackQueueViews';

export const dynamic = 'force-dynamic';
const FEEDBACKS_PER_PAGE = 25;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const viewParam = params.view;
  const rawView = Array.isArray(viewParam) ? viewParam[0] : viewParam;
  const view: FeedbackQueueView = rawView === 'snoozed' ? 'snoozed' : 'active';
  const pageParam = params.page;
  const rawPage = Array.isArray(pageParam) ? pageParam[0] : pageParam;
  const currentPage = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1);

  const result = await getFeedbackQueueCandidatesPage({
    view,
    page: currentPage,
    pageSize: FEEDBACKS_PER_PAGE,
  });
  const students = result.items;
  const totalStudents = result.total;
  const totalPages = result.totalPages;
  const needsAttentionCount = result.totalNeedsAttention;
  const dueInQueueCount = students.filter((s) => s.dueByTime).length;
  const hasPreviousPage = result.page > 1;
  const hasNextPage = result.page < totalPages;
  const pageStart = students.length === 0 ? 0 : (result.page - 1) * FEEDBACKS_PER_PAGE + 1;
  const pageEnd = students.length === 0 ? 0 : Math.min(result.page * FEEDBACKS_PER_PAGE, totalStudents);
  const pagesToRender = Array.from({ length: totalPages }, (_, idx) => idx + 1).filter(
    (page) => Math.abs(page - result.page) <= 2 || page === 1 || page === totalPages
  );
  const uniquePagesToRender = pagesToRender.filter(
    (page, index) => pagesToRender.indexOf(page) === index
  );
  const gapsBeforePage = (page: number): boolean => {
    const idx = uniquePagesToRender.indexOf(page);
    if (idx <= 0) return false;
    return page - uniquePagesToRender[idx - 1] > 1;
  };
  const buildFeedbackUrl = (nextPage: number): string => {
    const query = new URLSearchParams();
    if (view === 'snoozed') query.set('view', 'snoozed');
    if (nextPage > 1) query.set('page', String(nextPage));
    const qs = query.toString();
    return qs ? `/feedback?${qs}` : '/feedback';
  };

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

      <div className="mb-3 flex items-center justify-between text-sm text-slate-500">
        <p>
          Showing {pageStart}-{pageEnd} of {totalStudents} students
        </p>
        <p>{FEEDBACKS_PER_PAGE} per page</p>
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

      <FeedbackQueueViews students={students} view={view} />

      {students.length > 0 ? (
        <p className="mt-4 text-sm text-slate-500">Sorted by priority: needs attention first, then oldest feedback date.</p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link
          href={buildFeedbackUrl(Math.max(1, result.page - 1))}
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
          <span key={page}>
            {gapsBeforePage(page) ? (
              <span className="px-1 text-slate-400" aria-hidden="true">
                ...
              </span>
            ) : null}
            <Link
              href={buildFeedbackUrl(page)}
              aria-current={result.page === page ? 'page' : undefined}
              className={`inline-flex h-9 min-w-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition ${
                result.page === page
                  ? 'border-primary bg-primary text-white'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {page}
            </Link>
          </span>
        ))}

        <Link
          href={buildFeedbackUrl(Math.min(totalPages, result.page + 1))}
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
