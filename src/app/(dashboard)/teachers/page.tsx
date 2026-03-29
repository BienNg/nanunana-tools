import { getSupabaseAdmin } from '@/lib/supabase/admin';
import TeachersClient from './TeachersClient';

export const dynamic = 'force-dynamic';

export default async function TeachersPage() {
  const supabase = getSupabaseAdmin();
  const { data: teachers, error } = await supabase
    .from('teachers')
    .select('id, name')
    .order('name');

  if (error) {
    console.error('Error fetching teachers:', error);
  }

  return <TeachersClient initialTeachers={teachers || []} />;
}