import { revalidatePath } from 'next/cache';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  mergeStudentsByNameLength,
  StudentMergeError,
  type TieWinnerChoice,
} from '@/lib/students/studentMerge';

export const runtime = 'nodejs';

type PostBody = {
  mode?: 'alias' | 'merge';
  studentId?: unknown;
  alias?: unknown;
  leftStudentId?: unknown;
  rightStudentId?: unknown;
  tieWinnerStudentId?: unknown;
};
type DeleteBody = { studentId?: unknown; aliasId?: unknown };

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const mode = body.mode ?? 'alias';
  const supabase = getSupabaseAdmin();

  if (mode === 'merge') {
    const leftStudentId = typeof body.leftStudentId === 'string' ? body.leftStudentId.trim() : '';
    const rightStudentId =
      typeof body.rightStudentId === 'string' ? body.rightStudentId.trim() : '';
    const tieWinnerStudentId =
      typeof body.tieWinnerStudentId === 'string' ? body.tieWinnerStudentId.trim() : '';

    if (!leftStudentId || !rightStudentId) {
      return Response.json(
        { error: 'leftStudentId and rightStudentId are required for merge mode' },
        { status: 400 }
      );
    }
    const tieWinner: TieWinnerChoice | undefined = tieWinnerStudentId
      ? { winnerStudentId: tieWinnerStudentId }
      : undefined;

    try {
      const result = await mergeStudentsByNameLength(supabase, {
        leftStudentId,
        rightStudentId,
        tieWinner,
      });

      revalidatePath('/students');
      revalidatePath('/teachers');
      revalidatePath('/courses');
      return Response.json({ success: true, merge: result });
    } catch (error) {
      if (error instanceof StudentMergeError) {
        const statusByCode: Record<StudentMergeError['code'], number> = {
          INVALID_INPUT: 400,
          STUDENT_NOT_FOUND: 404,
          GROUP_MISMATCH: 409,
          TIE_CHOICE_REQUIRED: 409,
          INVALID_TIE_WINNER: 400,
          ALIAS_OWNED_BY_OTHER_STUDENT: 409,
          DB_ERROR: 500,
        };
        return Response.json(
          {
            error: error.message,
            code: error.code,
          },
          { status: statusByCode[error.code] ?? 500 }
        );
      }
      return Response.json({ error: 'Failed to merge students' }, { status: 500 });
    }
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
