'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function markStudentFeedbackDone(studentId: string): Promise<void> {
  if (!isValidUuid(studentId)) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from('students')
    .update({
      feedback_sent_at: nowIso,
      feedback_done_at: nowIso,
      feedback_snoozed_until: null,
    })
    .eq('id', studentId);

  if (error) {
    console.error('markStudentFeedbackDone failed', error);
    return;
  }

  revalidatePath('/feedback');
}
