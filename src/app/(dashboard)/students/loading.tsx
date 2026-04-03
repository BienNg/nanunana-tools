export default function StudentsLoading() {
  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <div className="h-10 w-56 rounded bg-slate-200 animate-pulse" />
        <div className="mt-3 h-4 w-full max-w-2xl rounded bg-slate-200 animate-pulse" />
      </div>

      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="h-10 w-full rounded-lg bg-slate-200 animate-pulse md:max-w-md" />
          <div className="h-10 w-full rounded-lg bg-slate-200 animate-pulse md:max-w-xs" />
          <div className="h-10 w-20 rounded-lg bg-slate-200 animate-pulse" />
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <div className="h-4 w-56 rounded bg-slate-200 animate-pulse" />
        <div className="h-4 w-24 rounded bg-slate-200 animate-pulse" />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-6 py-4 text-left">
                <div className="h-3 w-20 rounded bg-slate-200 animate-pulse" />
              </th>
              <th className="px-6 py-4 text-left">
                <div className="h-3 w-24 rounded bg-slate-200 animate-pulse" />
              </th>
              <th className="px-6 py-4 text-left">
                <div className="h-3 w-28 rounded bg-slate-200 animate-pulse" />
              </th>
              <th className="px-6 py-4 text-left">
                <div className="h-3 w-16 rounded bg-slate-200 animate-pulse" />
              </th>
              <th className="px-6 py-4 text-left">
                <div className="h-3 w-14 rounded bg-slate-200 animate-pulse" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Array.from({ length: 8 }).map((_, idx) => (
              <tr key={idx}>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-slate-200 animate-pulse" />
                    <div className="h-4 w-36 rounded bg-slate-200 animate-pulse" />
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="h-4 w-28 rounded bg-slate-200 animate-pulse" />
                </td>
                <td className="px-6 py-4">
                  <div className="h-4 w-36 rounded bg-slate-200 animate-pulse" />
                </td>
                <td className="px-6 py-4">
                  <div className="h-4 w-24 rounded bg-slate-200 animate-pulse" />
                </td>
                <td className="px-6 py-4">
                  <div className="h-4 w-40 rounded bg-slate-200 animate-pulse" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
