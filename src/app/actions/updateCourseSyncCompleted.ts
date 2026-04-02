'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function updateCourseSyncCompleted(courseId: string, completed: boolean) {
  if (!isValidUuid(courseId)) {
    return { ok: false as const, error: 'Invalid course id.' };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('courses').update({ sync_completed: completed }).eq('id', courseId);
  if (error) {
    return { ok: false as const, error: error.message };
  }

  revalidatePath('/');
  revalidatePath('/groups');
  revalidatePath('/groups/[id]', 'page');
  revalidatePath('/courses');
  revalidatePath('/courses/[id]', 'page');
  revalidatePath('/teachers');
  revalidatePath('/teachers/[id]', 'page');

  return { ok: true as const, completed };
}
