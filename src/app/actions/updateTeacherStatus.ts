'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type TeacherStatus = 'active' | 'inactive';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function updateTeacherStatus(teacherId: string, status: TeacherStatus) {
  if (!isValidUuid(teacherId)) {
    return { ok: false as const, error: 'Invalid teacher id.' };
  }
  if (status !== 'active' && status !== 'inactive') {
    return { ok: false as const, error: 'Invalid status.' };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('teachers').update({ status }).eq('id', teacherId);

  if (error) {
    return { ok: false as const, error: error.message };
  }

  revalidatePath('/teachers');
  revalidatePath(`/teachers/${teacherId}`);

  return { ok: true as const };
}
