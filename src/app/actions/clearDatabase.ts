'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/** Sentinel UUID: no row uses this, so neq matches every real row. */
const SENTINEL_ID = '00000000-0000-0000-0000-000000000000';

async function assertLocalhostRequest() {
  const h = await headers();
  const raw = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const hostname = raw.split(':')[0]?.toLowerCase() ?? '';
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error('This action is only allowed when the app is served on localhost.');
  }
}

export async function clearAllDatabaseEntries() {
  await assertLocalhostRequest();
  const supabase = getSupabaseAdmin();
  const { error: groupsError } = await supabase.from('groups').delete().neq('id', SENTINEL_ID);
  if (groupsError) {
    return { ok: false as const, error: groupsError.message };
  }
  const { error: coursesError } = await supabase.from('courses').delete().neq('id', SENTINEL_ID);
  if (coursesError) {
    return { ok: false as const, error: coursesError.message };
  }
  const { error: teachersError } = await supabase.from('teachers').delete().neq('id', SENTINEL_ID);
  if (teachersError) {
    return { ok: false as const, error: teachersError.message };
  }
  revalidatePath('/');
  return { ok: true as const };
}
