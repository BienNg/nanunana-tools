import { NextResponse } from 'next/server';

import { getTeachersWithHoursByStatus, type StatusFilter } from '@/app/(dashboard)/teachers/teacherHours.server';

export const dynamic = 'force-dynamic';

function parseStatusFilter(status: string | null): StatusFilter {
  if (status === 'all' || status === 'inactive' || status === 'active') return status;
  return 'active';
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = parseStatusFilter(searchParams.get('status'));
  const teachers = await getTeachersWithHoursByStatus(status);
  return NextResponse.json({ teachers });
}
