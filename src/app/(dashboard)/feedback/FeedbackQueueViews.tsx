'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { FeedbackQueueCandidate, FeedbackQueueView } from './feedbackStudents.server';
import { markStudentFeedbackDone } from '@/app/actions/markStudentFeedbackDone';
import { snoozeStudentFeedback, unsnoozeStudentFeedback } from '@/app/actions/snoozeStudentFeedback';

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString();
}

function formatOptionalDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleDateString();
}

export default function FeedbackQueueViews({
  students,
  view,
  mode,
}: {
  students: FeedbackQueueCandidate[];
  view: FeedbackQueueView;
  mode: 'focused' | 'list';
}) {
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    setFocusedIndex(0);
  }, [students, view]);

  const focusedStudent = useMemo(
    () => (students.length > 0 ? students[Math.min(focusedIndex, students.length - 1)] : null),
    [students, focusedIndex]
  );

  return (
    <>
      {mode === 'focused' ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          {focusedStudent ? (
            <>
              <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex flex-col items-center gap-3">
                  <p className="text-sm text-slate-500">
                    Student {focusedIndex + 1} of {students.length}
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setFocusedIndex((i) => Math.max(0, i - 1))}
                      disabled={focusedIndex === 0}
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setFocusedIndex((i) => Math.min(students.length - 1, i + 1))}
                      disabled={focusedIndex >= students.length - 1}
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 md:col-span-2">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                        {focusedStudent.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-lg font-semibold text-slate-900">{focusedStudent.name}</span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-100 p-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Courses</p>
                    <div className="flex flex-col gap-2 text-sm text-slate-700">
                      {focusedStudent.courses.length === 0 ? (
                        <span className="text-slate-400">-</span>
                      ) : (
                        focusedStudent.courses.map((course) => (
                          <div key={course.id} className="min-w-0">
                            <Link
                              href={`/courses/${course.id}`}
                              className="text-primary font-medium underline-offset-2 hover:text-primary/80 hover:underline break-words"
                            >
                              {course.groupName ? `${course.groupName} — ${course.name}` : course.name}
                            </Link>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-100 p-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Missing since feedback
                    </p>
                    <p className="text-sm font-semibold text-slate-900">{focusedStudent.absentSinceFeedbackCount}</p>
                  </div>

                  <div className="rounded-xl border border-slate-100 p-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Last feedback</p>
                    <p className="text-sm text-slate-700">{formatDate(focusedStudent.feedbackSentAt)}</p>
                  </div>

                  <div className="rounded-xl border border-slate-100 p-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Snoozed until</p>
                    <p className="text-sm text-slate-700">{formatOptionalDate(focusedStudent.feedbackSnoozedUntil)}</p>
                  </div>

                  <div className="rounded-xl border border-slate-100 p-4 md:col-span-2">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Queue reason</p>
                    <p className="text-sm text-slate-700">
                      {focusedStudent.queueReasonDetails.length > 0
                        ? focusedStudent.queueReasonDetails.join(' | ')
                        : '-'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-4 md:col-span-2 pt-2">
                    <form action={markStudentFeedbackDone.bind(null, focusedStudent.id)}>
                      <button
                        type="submit"
                        className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-8 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                      >
                        Done
                      </button>
                    </form>
                    {view === 'active' ? (
                      <form action={snoozeStudentFeedback.bind(null, focusedStudent.id, 7)}>
                        <button
                          type="submit"
                          className="inline-flex min-h-11 items-center justify-center rounded-full border border-slate-200 bg-white px-8 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Snooze 7d
                        </button>
                      </form>
                    ) : (
                      <form action={unsnoozeStudentFeedback.bind(null, focusedStudent.id)}>
                        <button
                          type="submit"
                          className="inline-flex min-h-11 items-center justify-center rounded-full border border-slate-200 bg-white px-8 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Unsnooze
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="py-8 text-center text-slate-500">No students in this view.</div>
          )}
        </div>
      ) : (
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
                      <span className="text-slate-400">-</span>
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
                    <span className="font-semibold text-slate-900">{student.absentSinceFeedbackCount}</span>
                  </td>
                  <td className="py-4 px-6 text-sm text-slate-700">
                    {formatDate(student.feedbackSentAt)}
                  </td>
                  <td className="py-4 px-6 text-sm text-slate-700">
                    {formatOptionalDate(student.feedbackSnoozedUntil)}
                  </td>
                  <td className="py-4 px-6 text-sm text-slate-700">
                    {student.queueReasonDetails.length > 0 ? (
                      <p className="text-xs text-slate-500">{student.queueReasonDetails.join(' | ')}</p>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
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
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
