import Link from 'next/link';
import { Fragment } from 'react';
import { getFeedbackQueueCandidates } from './feedbackStudents.server';

export const dynamic = 'force-dynamic';

export default async function FeedbackPage() {
  const students = await getFeedbackQueueCandidates();

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
          Feedback
        </h2>
        <p className="text-on-surface-variant max-w-2xl">
          Students who are due for feedback this week or have more than one absence since last feedback.
        </p>
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
                  {student.feedbackSentAt ? new Date(student.feedbackSentAt).toLocaleDateString() : 'Never'}
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={4} className="py-12 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center">
                    <span className="material-symbols-outlined mb-3 text-4xl text-slate-300">inbox</span>
                    <p>No students are due for feedback right now.</p>
                    <p className="mt-1 text-sm text-slate-400">
                      Students appear after the first-week enrollment gate and queue rules are met.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {students.length > 0 ? (
        <p className="mt-4 text-sm text-slate-500">{students.length} students</p>
      ) : null}
    </div>
  );
}
