import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePersonNameKey } from '@/lib/normalizePersonName';

type StudentIdentity = { id: string; name: string; group_id: string | null };

export type TieWinnerChoice = {
  winnerStudentId: string;
};

export class StudentMergeError extends Error {
  code:
    | 'INVALID_INPUT'
    | 'STUDENT_NOT_FOUND'
    | 'GROUP_MISMATCH'
    | 'TIE_CHOICE_REQUIRED'
    | 'INVALID_TIE_WINNER'
    | 'ALIAS_OWNED_BY_OTHER_STUDENT'
    | 'DB_ERROR';

  constructor(
    code: StudentMergeError['code'],
    message: string
  ) {
    super(message);
    this.name = 'StudentMergeError';
    this.code = code;
  }
}

type MergeSelection = {
  winner: StudentIdentity;
  loser: StudentIdentity;
  wasTie: boolean;
};

export type MergeStudentsInput = {
  leftStudentId: string;
  rightStudentId: string;
  tieWinner?: TieWinnerChoice;
  expectedGroupId?: string;
};

export type MergeStudentsResult = {
  winnerStudentId: string;
  loserStudentId: string;
  winnerName: string;
  loserName: string;
  groupId: string;
  wasTie: boolean;
};

function displayLength(name: string): number {
  return [...name.trim()].length;
}

function selectWinnerByNameLength(
  left: StudentIdentity,
  right: StudentIdentity,
  tieWinner?: TieWinnerChoice
): MergeSelection {
  const leftLen = displayLength(left.name);
  const rightLen = displayLength(right.name);

  if (leftLen > rightLen) {
    return { winner: left, loser: right, wasTie: false };
  }
  if (rightLen > leftLen) {
    return { winner: right, loser: left, wasTie: false };
  }

  if (!tieWinner?.winnerStudentId) {
    throw new StudentMergeError(
      'TIE_CHOICE_REQUIRED',
      `Students "${left.name}" and "${right.name}" have the same length; choose which student to keep.`
    );
  }
  if (tieWinner.winnerStudentId === left.id) {
    return { winner: left, loser: right, wasTie: true };
  }
  if (tieWinner.winnerStudentId === right.id) {
    return { winner: right, loser: left, wasTie: true };
  }
  throw new StudentMergeError(
    'INVALID_TIE_WINNER',
    'tie winner must be one of the two student ids being merged'
  );
}

async function loadStudentPair(
  supabase: SupabaseClient,
  leftStudentId: string,
  rightStudentId: string
): Promise<[StudentIdentity, StudentIdentity]> {
  const { data, error } = await supabase
    .from('students')
    .select('id, name, group_id')
    .in('id', [leftStudentId, rightStudentId]);
  if (error) throw new StudentMergeError('DB_ERROR', error.message);

  const rows = (data ?? []) as StudentIdentity[];
  const left = rows.find((r) => r.id === leftStudentId);
  const right = rows.find((r) => r.id === rightStudentId);
  if (!left || !right) {
    throw new StudentMergeError('STUDENT_NOT_FOUND', 'Both students must exist to merge.');
  }
  return [left, right];
}

async function assertAliasOwnershipSafe(
  supabase: SupabaseClient,
  groupId: string,
  normalizedKey: string,
  winnerId: string,
  loserId: string
): Promise<void> {
  const { data: existing, error } = await supabase
    .from('student_aliases')
    .select('id, student_id')
    .eq('group_id', groupId)
    .eq('normalized_key', normalizedKey)
    .maybeSingle();
  if (error) throw new StudentMergeError('DB_ERROR', error.message);
  if (!existing) return;
  const owner = String(existing.student_id ?? '');
  if (!owner || owner === winnerId || owner === loserId) return;
  throw new StudentMergeError(
    'ALIAS_OWNED_BY_OTHER_STUDENT',
    'Cannot merge because one alias key belongs to another student in this group.'
  );
}

function remapCacheValues(cache: Map<string, string>, fromId: string, toId: string): void {
  for (const [k, v] of cache) {
    if (v === fromId) cache.set(k, toId);
  }
}

async function repointCourseStudents(
  supabase: SupabaseClient,
  winnerId: string,
  loserId: string
): Promise<void> {
  const { data: loserRows, error: selectErr } = await supabase
    .from('course_students')
    .select('course_id')
    .eq('student_id', loserId);
  if (selectErr) throw new StudentMergeError('DB_ERROR', selectErr.message);

  const rows = (loserRows ?? []).map((row) => ({
    course_id: String(row.course_id),
    student_id: winnerId,
  }));
  if (rows.length > 0) {
    const { error: insErr } = await supabase
      .from('course_students')
      .upsert(rows, { onConflict: 'course_id,student_id' });
    if (insErr) throw new StudentMergeError('DB_ERROR', insErr.message);
  }

  const { error: delErr } = await supabase.from('course_students').delete().eq('student_id', loserId);
  if (delErr) throw new StudentMergeError('DB_ERROR', delErr.message);
}

async function repointAttendanceRecords(
  supabase: SupabaseClient,
  winnerId: string,
  loserId: string
): Promise<void> {
  const { data: loserRows, error: selectErr } = await supabase
    .from('attendance_records')
    .select('lesson_id, status, feedback')
    .eq('student_id', loserId);
  if (selectErr) throw new StudentMergeError('DB_ERROR', selectErr.message);

  const rows = (loserRows ?? []).map((row) => ({
    lesson_id: String(row.lesson_id),
    student_id: winnerId,
    status: String(row.status ?? ''),
    feedback: String(row.feedback ?? ''),
  }));
  if (rows.length > 0) {
    const { error: insErr } = await supabase
      .from('attendance_records')
      .upsert(rows, { onConflict: 'lesson_id,student_id' });
    if (insErr) throw new StudentMergeError('DB_ERROR', insErr.message);
  }

  const { error: delErr } = await supabase.from('attendance_records').delete().eq('student_id', loserId);
  if (delErr) throw new StudentMergeError('DB_ERROR', delErr.message);
}

async function repointAliasesAndAddLoserName(
  supabase: SupabaseClient,
  groupId: string,
  winnerId: string,
  loserId: string,
  loserName: string
): Promise<void> {
  const { data: loserAliasRows, error: aliasesErr } = await supabase
    .from('student_aliases')
    .select('alias, normalized_key')
    .eq('student_id', loserId);
  if (aliasesErr) throw new StudentMergeError('DB_ERROR', aliasesErr.message);

  const candidateAliases = new Map<string, string>();
  for (const row of loserAliasRows ?? []) {
    const alias = String(row.alias ?? '').trim();
    const normalized = String(row.normalized_key ?? '').trim();
    if (!alias || !normalized) continue;
    if (!candidateAliases.has(normalized)) candidateAliases.set(normalized, alias);
  }

  const loserNameTrimmed = loserName.trim();
  const loserNameNk = normalizePersonNameKey(loserNameTrimmed);
  if (loserNameTrimmed && loserNameNk) {
    candidateAliases.set(loserNameNk, loserNameTrimmed);
  }

  for (const normalizedKey of candidateAliases.keys()) {
    await assertAliasOwnershipSafe(supabase, groupId, normalizedKey, winnerId, loserId);
  }

  if (candidateAliases.size > 0) {
    const rows = [...candidateAliases.entries()].map(([normalized_key, alias]) => ({
      group_id: groupId,
      student_id: winnerId,
      alias,
      normalized_key,
    }));
    const { error: upsertErr } = await supabase
      .from('student_aliases')
      .upsert(rows, { onConflict: 'group_id,normalized_key' });
    if (upsertErr) throw new StudentMergeError('DB_ERROR', upsertErr.message);
  }

  const { error: cleanupErr } = await supabase
    .from('student_aliases')
    .delete()
    .eq('student_id', loserId);
  if (cleanupErr) throw new StudentMergeError('DB_ERROR', cleanupErr.message);
}

export async function dryValidateMergeStudents(
  supabase: SupabaseClient,
  input: MergeStudentsInput
): Promise<MergeSelection> {
  const leftStudentId = input.leftStudentId.trim();
  const rightStudentId = input.rightStudentId.trim();
  if (!leftStudentId || !rightStudentId) {
    throw new StudentMergeError('INVALID_INPUT', 'Both student ids are required');
  }
  if (leftStudentId === rightStudentId) {
    throw new StudentMergeError('INVALID_INPUT', 'Cannot merge the same student');
  }

  const [left, right] = await loadStudentPair(supabase, leftStudentId, rightStudentId);
  if (input.expectedGroupId) {
    const expected = input.expectedGroupId;
    if (left.group_id !== expected || right.group_id !== expected) {
      throw new StudentMergeError('GROUP_MISMATCH', 'Students do not belong to the expected group');
    }
  }

  return selectWinnerByNameLength(left, right, input.tieWinner);
}

export async function mergeStudentsByNameLength(
  supabase: SupabaseClient,
  input: MergeStudentsInput
): Promise<MergeStudentsResult> {
  const selected = await dryValidateMergeStudents(supabase, input);
  const winner = selected.winner;
  const loser = selected.loser;
  if (!winner.group_id) {
    throw new StudentMergeError(
      'INVALID_INPUT',
      'Winner student must have a group_id to keep aliases.'
    );
  }
  const groupId = String(winner.group_id);

  await repointCourseStudents(supabase, winner.id, loser.id);
  await repointAttendanceRecords(supabase, winner.id, loser.id);
  await repointAliasesAndAddLoserName(supabase, groupId, winner.id, loser.id, loser.name);

  const { error: delErr } = await supabase.from('students').delete().eq('id', loser.id);
  if (delErr) throw new StudentMergeError('DB_ERROR', delErr.message);

  return {
    winnerStudentId: winner.id,
    loserStudentId: loser.id,
    winnerName: winner.name,
    loserName: loser.name,
    groupId,
    wasTie: selected.wasTie,
  };
}

export function rewriteStudentIdMappings(
  cache: Map<string, string>,
  validStudentIds: Set<string>,
  loserId: string,
  winnerId: string
): void {
  remapCacheValues(cache, loserId, winnerId);
  validStudentIds.delete(loserId);
  validStudentIds.add(winnerId);
}
