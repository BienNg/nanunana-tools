'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function snoozeStudentFeedback(studentId: string, days = 7): Promise<void> {
  if (!isValidUuid(studentId)) return;
  if (!Number.isFinite(days) || days <= 0) return;

  const supabase = getSupabaseAdmin();
  const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('students')
    .update({ feedback_snoozed_until: snoozedUntil })
    .eq('id', studentId);

  if (error) {
    console.error('snoozeStudentFeedback failed', error);
    return;
  }

  revalidatePath('/feedback');
}

export async function unsnoozeStudentFeedback(studentId: string): Promise<void> {
  if (!isValidUuid(studentId)) return;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('students')
    .update({ feedback_snoozed_until: null })
    .eq('id', studentId);

  if (error) {
    console.error('unsnoozeStudentFeedback failed', error);
    return;
  }

  revalidatePath('/feedback');
}
