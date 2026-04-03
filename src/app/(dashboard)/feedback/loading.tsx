export default function FeedbackLoading() {
  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <div className="h-10 w-44 animate-pulse rounded-lg bg-slate-200" />
        <div className="mt-3 h-4 w-[32rem] max-w-full animate-pulse rounded bg-slate-100" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
            <div className="mt-3 h-8 w-14 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="h-8 w-24 animate-pulse rounded-full bg-slate-200" />
        <div className="h-8 w-20 animate-pulse rounded-full bg-slate-100" />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-7 gap-4 border-b border-slate-200 bg-slate-50 px-6 py-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-3 w-20 animate-pulse rounded bg-slate-200" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, row) => (
          <div key={row} className="grid grid-cols-7 gap-4 border-b border-slate-100 px-6 py-4 last:border-b-0">
            {Array.from({ length: 7 }).map((_, col) => (
              <div key={col} className="h-4 w-full animate-pulse rounded bg-slate-100" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
