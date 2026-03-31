'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

type Teacher = {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  monthHours: { label: string; hoursDisplay: string }[];
};

type StatusFilter = 'active' | 'all' | 'inactive';

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string; description: string }[] = [
  { value: 'active', label: 'Active only', description: 'Hide inactive teachers' },
  { value: 'all', label: 'All teachers', description: 'Include inactive' },
  { value: 'inactive', label: 'Inactive only', description: 'Former / inactive only' },
];

function StatusFilterMenu({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentLabel = STATUS_FILTER_OPTIONS.find((o) => o.value === value)?.label ?? 'Filter';

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 pl-3 pr-3 py-2.5 bg-white border border-slate-200 rounded-lg shadow-sm text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Filter teachers by status"
      >
        <span className="material-symbols-outlined text-[20px] text-slate-500" aria-hidden>
          filter_list
        </span>
        <span className="whitespace-nowrap">{currentLabel}</span>
        <span className="material-symbols-outlined text-[18px] text-slate-400" aria-hidden>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open ? (
        <div
          className="absolute right-0 mt-1 min-w-[240px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg z-50"
          role="menu"
        >
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${
                opt.value === value
                  ? 'bg-primary/10 text-primary font-bold'
                  : 'text-slate-800 hover:bg-slate-50 font-medium'
              }`}
            >
              <span className="block">{opt.label}</span>
              <span className="block text-xs font-normal text-slate-500 mt-0.5">{opt.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function TeachersClient({
  initialTeachers,
  monthColumnLabels,
}: {
  initialTeachers: Teacher[];
  monthColumnLabels: string[];
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const filteredTeachers = initialTeachers.filter((teacher) => {
    if (statusFilter === 'active' && teacher.status !== 'active') return false;
    if (statusFilter === 'inactive' && teacher.status !== 'inactive') return false;
    return teacher.name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
            Teachers
          </h2>
          <p className="text-on-surface-variant max-w-md">
            Manage and view all your teachers and their schedules.
          </p>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto md:items-center md:justify-end">
          <StatusFilterMenu value={statusFilter} onChange={setStatusFilter} />
          {/* Search Bar - HubSpot CRM style */}
          <div className="relative w-full sm:flex-1 md:w-80 md:flex-none">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              search
            </span>
            <input
              type="text"
              placeholder="Search teachers..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="py-4 px-6 text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
              {monthColumnLabels.map((label) => (
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
            {filteredTeachers.map((teacher) => (
              <tr 
                key={teacher.id} 
                className="hover:bg-slate-50/50 transition-colors cursor-pointer"
              >
                <td className="py-4 px-6">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                      {teacher.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium text-slate-900">{teacher.name}</span>
                    {teacher.status === 'inactive' ? (
                      <span className="ml-1 inline-flex items-center rounded-full bg-slate-200/80 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                        Inactive
                      </span>
                    ) : null}
                  </div>
                </td>
                {teacher.monthHours.map((col) => (
                  <td key={col.label} className="py-4 px-6 text-sm tabular-nums text-slate-700">
                    {col.hoursDisplay}
                    <span className="text-slate-400 ml-0.5">h</span>
                  </td>
                ))}
                <td className="py-4 px-6">
                  <Link 
                    href={`/teachers/${teacher.id}`}
                    className="inline-flex items-center text-sm font-medium text-primary hover:text-primary/80"
                  >
                    View Dashboard
                    <span className="material-symbols-outlined text-sm ml-1">arrow_forward</span>
                  </Link>
                </td>
              </tr>
            ))}
            {filteredTeachers.length === 0 && (
              <tr>
                <td colSpan={2 + monthColumnLabels.length} className="py-12 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center">
                    <span className="material-symbols-outlined text-4xl mb-3 text-slate-300">search_off</span>
                    <p>
                      {search.trim()
                        ? `No teachers found matching "${search}"`
                        : statusFilter === 'active'
                          ? 'No active teachers to show. Try "All teachers" to include inactive.'
                          : statusFilter === 'inactive'
                            ? 'No inactive teachers.'
                            : 'No teachers yet.'}
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}