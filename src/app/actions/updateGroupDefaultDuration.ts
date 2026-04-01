'use server';

import { revalidatePath } from 'next/cache';
import { parseGroupDefaultDurationHoursInput } from '@/lib/courseDuration';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function updateGroupDefaultDuration(groupId: string, hoursInput: string | null) {
  if (!isValidUuid(groupId)) {
    return { ok: false as const, error: 'Invalid group id.' };
  }

  const trimmed = (hoursInput ?? '').trim();
  const nextMinutes = trimmed === '' ? null : parseGroupDefaultDurationHoursInput(trimmed);
  if (trimmed !== '' && nextMinutes == null) {
    return { ok: false as const, error: 'Enter a valid duration in hours (e.g. 1.25).' };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('groups')
    .update({ default_lesson_minutes: nextMinutes })
    .eq('id', groupId);
  if (error) {
    return { ok: false as const, error: error.message };
  }

  revalidatePath('/groups');
  revalidatePath(`/groups/${groupId}`);
  revalidatePath('/courses');
  revalidatePath('/courses/[id]', 'page');
  revalidatePath('/teachers');
  revalidatePath('/teachers/[id]', 'page');

  return { ok: true as const, defaultLessonMinutes: nextMinutes };
}

