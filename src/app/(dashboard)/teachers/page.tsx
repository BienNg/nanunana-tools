import TeachersClient from './TeachersClient';
import { getLastThreeMonthBuckets, getTeachersWithHoursByStatus } from './teacherHours.server';

export const dynamic = 'force-dynamic';

export default async function TeachersPage() {
  const [teachersWithHours, monthBuckets] = await Promise.all([
    getTeachersWithHoursByStatus('active'),
    Promise.resolve(getLastThreeMonthBuckets()),
  ]);

  return (
    <TeachersClient
      initialTeachers={teachersWithHours}
      monthColumnLabels={monthBuckets.map((b) => b.label)}
    />
  );
}
