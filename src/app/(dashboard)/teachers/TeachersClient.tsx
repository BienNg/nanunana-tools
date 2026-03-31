'use client';

import { useState } from 'react';
import Link from 'next/link';

type Teacher = {
  id: string;
  name: string;
  monthHours: { label: string; hoursDisplay: string }[];
};

export default function TeachersClient({
  initialTeachers,
  monthColumnLabels,
}: {
  initialTeachers: Teacher[];
  monthColumnLabels: string[];
}) {
  const [search, setSearch] = useState('');
  
  const filteredTeachers = initialTeachers.filter((teacher) =>
    teacher.name.toLowerCase().includes(search.toLowerCase())
  );

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
        
        {/* Search Bar - HubSpot CRM style */}
        <div className="relative w-full md:w-80">
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
                    <p>No teachers found matching "{search}"</p>
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