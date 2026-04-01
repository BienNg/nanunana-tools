'use server';

import { revalidatePath } from 'next/cache';
import { parseWorkbookClassTypeInput } from '@/lib/courseDuration';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function updateGroupClassType(groupId: string, classTypeInput: string | null) {
  if (!isValidUuid(groupId)) {
    return { ok: false as const, error: 'Invalid group id.' };
  }

  const normalized = parseWorkbookClassTypeInput(classTypeInput);
  if (classTypeInput != null && classTypeInput.trim() !== '' && normalized == null) {
    return { ok: false as const, error: 'Invalid course type.' };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('groups').update({ class_type: normalized }).eq('id', groupId);
  if (error) {
    return { ok: false as const, error: error.message };
  }

  revalidatePath('/groups');
  revalidatePath(`/groups/${groupId}`);
  revalidatePath('/courses');
  revalidatePath('/courses/[id]', 'page');
  revalidatePath('/teachers');
  revalidatePath('/teachers/[id]', 'page');

  return { ok: true as const, classType: normalized };
}
