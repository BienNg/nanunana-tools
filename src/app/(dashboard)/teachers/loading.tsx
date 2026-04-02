export default function TeachersLoading() {
  const monthLabels = ['APR 2026', 'MAR 2026', 'FEB 2026'];

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div className="h-11 w-48 rounded bg-slate-200 animate-pulse" />
          <div className="mt-2 h-5 w-80 rounded bg-slate-200 animate-pulse" />
        </div>

        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto md:items-center md:justify-end">
          <div className="h-11 w-36 rounded-lg bg-slate-200 animate-pulse" />
          <div className="h-11 w-full sm:w-80 rounded-lg bg-slate-200 animate-pulse" />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
              {monthLabels.map((label) => (
                <th
                  key={label}
                  className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"
                >
                  {label}
                </th>
              ))}
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Array.from({ length: 8 }).map((_, rowIdx) => (
              <tr key={`teachers-route-skeleton-${rowIdx}`} className="animate-pulse">
                <td className="py-4 px-6">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-slate-200" />
                    <div className="h-4 w-32 rounded bg-slate-200" />
                  </div>
                </td>
                {monthLabels.map((label) => (
                  <td key={`teachers-route-skeleton-${rowIdx}-${label}`} className="py-4 px-6">
                    <div className="h-4 w-10 rounded bg-slate-200" />
                  </td>
                ))}
                <td className="py-4 px-6">
                  <div className="h-4 w-24 rounded bg-slate-200" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
