'use client';

import Link from 'next/link';
import { useState } from 'react';

type SessionRow = {
  id: string;
  course_id: string;
  date: string | null;
  start_time?: string | null;
  end_time?: string | null;
  calculatedDurationMinutes?: number;
  courses?: { name?: string } | null;
  attendance_records?: { status: string }[] | null;
};

export type TeacherSessionsCourseTab = {
  courseId: string;
  name: string;
  groupName?: string | null;
  sessions: SessionRow[];
};

type TabState = { kind: 'all' } | { kind: 'course'; courseId: string };

function SessionsTable({ sessions }: { sessions: SessionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-on-surface-variant">
            <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Date & Time</th>
            <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Session Title</th>
            <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Students</th>
            <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Duration</th>
            <th className="pb-6 font-bold uppercase tracking-widest text-[10px]">Status</th>
            <th className="pb-6 text-right"></th>
          </tr>
        </thead>
        <tbody className="text-sm font-medium">
          {sessions.length > 0 ? (
            sessions.map((session) => {
              const presentCount = (session.attendance_records || []).filter((r) => r.status === 'Present')
                .length;
              const totalCount = (session.attendance_records || []).length;

              const isCompleted = session.date && new Date(session.date) < new Date();
              const statusBg = isCompleted ? 'bg-tertiary-container' : 'bg-surface-container-high';
              const statusText = isCompleted ? 'text-on-tertiary-container' : 'text-on-surface-variant';
              const statusLabel = isCompleted ? 'Completed' : 'Pending';

              const durationHrs = session.calculatedDurationMinutes
                ? (session.calculatedDurationMinutes / 60).toFixed(1)
                : '0';

              const dateStr = session.date
                ? new Date(session.date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : 'No Date';

              return (
                <tr key={session.id} className="hover:bg-surface-container-low transition-colors group">
                  <td className="py-5 pr-4">
                    <div className="flex flex-col">
                      <span>{dateStr}</span>
                      <span className="text-xs text-on-surface-variant">
                        {session.start_time ? session.start_time.substring(0, 5) : '--:--'} -{' '}
                        {session.end_time ? session.end_time.substring(0, 5) : '--:--'}
                      </span>
                    </div>
                  </td>
                  <td className="py-5 pr-4">
                    <p className="font-bold text-on-surface">{session.courses?.name ?? '—'}</p>
                  </td>
                  <td className="py-5 pr-4">{totalCount > 0 ? `${presentCount} / ${totalCount}` : '-'}</td>
                  <td className="py-5 pr-4">{durationHrs} hrs</td>
                  <td className="py-5 pr-4">
                    <span className={`${statusBg} ${statusText} px-3 py-1 rounded-full text-xs font-bold`}>
                      {statusLabel}
                    </span>
                  </td>
                  <td className="py-5 text-right">
                    <Link href={`/courses/${session.course_id}`}>
                      <span className="material-symbols-outlined text-outline hover:text-primary transition-colors cursor-pointer">
                        arrow_forward_ios
                      </span>
                    </Link>
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={6} className="py-12 text-center text-on-surface-variant">
                No sessions in this view.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function TeacherSessionsSection({
  allSessions,
  courseTabs,
}: {
  allSessions: SessionRow[];
  courseTabs: TeacherSessionsCourseTab[];
}) {
  const [tab, setTab] = useState<TabState>({ kind: 'all' });

  const activeSessions =
    tab.kind === 'all'
      ? allSessions
      : courseTabs.find((c) => c.courseId === tab.courseId)?.sessions ?? [];

  const heading =
    tab.kind === 'all'
      ? 'All sessions'
      : courseTabs.find((c) => c.courseId === tab.courseId)?.name ?? 'Course';

  const subtitle =
    tab.kind === 'all'
      ? `All ${allSessions.length} session${allSessions.length === 1 ? '' : 's'} in this period.`
      : (() => {
          const c = courseTabs.find((x) => x.courseId === tab.courseId);
          return c
            ? `${c.sessions.length} session${c.sessions.length === 1 ? '' : 's'} for ${c.name}.`
            : '';
        })();

  const tabButtonBase =
    'shrink-0 px-4 py-2 rounded-xl text-sm font-bold transition-colors border border-transparent';
  const tabButtonActive = 'bg-primary text-on-primary shadow-sm shadow-primary/20';
  const tabButtonIdle = 'text-on-surface-variant hover:bg-surface-container-low/80';

  return (
    <div className="bg-surface-container-lowest rounded-3xl p-8 border border-outline-variant/5">
      <div className="flex flex-col gap-6 mb-8">
        <div>
          <h3 className="text-xl font-bold font-headline">{heading}</h3>
          <p className="text-sm text-on-surface-variant font-medium mt-1">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:gap-1 sm:p-1 sm:rounded-2xl sm:bg-surface-container-low/60 sm:border sm:border-outline-variant/10 overflow-x-auto pb-1 -mb-1 sm:pb-0 sm:mb-0">
          <button
            type="button"
            className={`${tabButtonBase} ${tab.kind === 'all' ? tabButtonActive : tabButtonIdle}`}
            onClick={() => setTab({ kind: 'all' })}
          >
            All sessions
          </button>
          {courseTabs.map((c) => (
            <button
              key={c.courseId}
              type="button"
              className={`${tabButtonBase} ${
                tab.kind === 'course' && tab.courseId === c.courseId ? tabButtonActive : tabButtonIdle
              }`}
              onClick={() => setTab({ kind: 'course', courseId: c.courseId })}
            >
              {c.groupName ? `${c.name} · ${c.groupName}` : c.name}
            </button>
          ))}
        </div>
      </div>

      <SessionsTable sessions={activeSessions} />
    </div>
  );
}
