import { revalidatePath } from 'next/cache';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

type PostBody = { studentId?: unknown; alias?: unknown };
type DeleteBody = { studentId?: unknown; aliasId?: unknown };

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
  const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
  if (!studentId || !alias) {
    return Response.json({ error: 'studentId and alias are required' }, { status: 400 });
  }

  const normalizedKey = normalizePersonNameKey(alias);
  if (!normalizedKey) {
    return Response.json({ error: 'Alias is empty after normalization' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: studentRow, error: studentErr } = await supabase
    .from('students')
    .select('id, group_id')
    .eq('id', studentId)
    .maybeSingle();
  if (studentErr) return Response.json({ error: studentErr.message }, { status: 500 });
  if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });
  if (!studentRow.group_id) {
    return Response.json({ error: 'Student has no group_id; cannot save alias' }, { status: 400 });
  }

  const groupId = String(studentRow.group_id);
  const { data: existingAliasRow, error: existingAliasErr } = await supabase
    .from('student_aliases')
    .select('id, student_id')
    .eq('group_id', groupId)
    .eq('normalized_key', normalizedKey)
    .maybeSingle();
  if (existingAliasErr) return Response.json({ error: existingAliasErr.message }, { status: 500 });
  if (existingAliasRow && existingAliasRow.student_id !== studentId) {
    return Response.json({ error: 'Alias already belongs to another student in this group' }, { status: 409 });
  }

  const { error: upsertErr } = await supabase.from('student_aliases').upsert(
    {
      group_id: groupId,
      student_id: studentId,
      alias,
      normalized_key: normalizedKey,
    },
    { onConflict: 'group_id,normalized_key' }
  );
  if (upsertErr) return Response.json({ error: upsertErr.message }, { status: 500 });

  revalidatePath('/students');
  return Response.json({ success: true });
}

export async function DELETE(request: Request) {
  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
  const aliasId = typeof body.aliasId === 'string' ? body.aliasId.trim() : '';
  if (!studentId || !aliasId) {
    return Response.json({ error: 'studentId and aliasId are required' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('student_aliases').delete().eq('id', aliasId).eq('student_id', studentId);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  revalidatePath('/students');
  return Response.json({ success: true });
}
