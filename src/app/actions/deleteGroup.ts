'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function deleteGroupAndRelatedData(groupId: string) {
  if (!isValidUuid(groupId)) {
    return { ok: false as const, error: 'Invalid group id.' };
  }

  const supabase = getSupabaseAdmin();

  const { error: deleteGroupError } = await supabase.from('groups').delete().eq('id', groupId);
  if (deleteGroupError) {
    return { ok: false as const, error: deleteGroupError.message };
  }

  // Cleanup orphan teachers (no linked course_teachers row).
  const [{ data: allTeachers, error: allTeachersError }, { data: linkedTeacherRows, error: linkedTeacherRowsError }] =
    await Promise.all([
      supabase.from('teachers').select('id'),
      supabase.from('course_teachers').select('teacher_id'),
    ]);

  if (allTeachersError || linkedTeacherRowsError) {
    return {
      ok: false as const,
      error: allTeachersError?.message ?? linkedTeacherRowsError?.message ?? 'Failed to load teachers for cleanup.',
    };
  }

  const linkedTeacherIds = new Set((linkedTeacherRows ?? []).map((row) => row.teacher_id));
  const orphanTeacherIds = (allTeachers ?? [])
    .map((teacher) => teacher.id)
    .filter((teacherId) => !linkedTeacherIds.has(teacherId));

  if (orphanTeacherIds.length > 0) {
    const { error: deleteTeachersError } = await supabase.from('teachers').delete().in('id', orphanTeacherIds);
    if (deleteTeachersError) {
      return { ok: false as const, error: deleteTeachersError.message };
    }
  }

  // Cleanup orphan students (no linked course_students row).
  const [{ data: allStudents, error: allStudentsError }, { data: linkedStudentRows, error: linkedStudentRowsError }] =
    await Promise.all([
      supabase.from('students').select('id'),
      supabase.from('course_students').select('student_id'),
    ]);

  if (allStudentsError || linkedStudentRowsError) {
    return {
      ok: false as const,
      error: allStudentsError?.message ?? linkedStudentRowsError?.message ?? 'Failed to load students for cleanup.',
    };
  }

  const linkedStudentIds = new Set((linkedStudentRows ?? []).map((row) => row.student_id));
  const orphanStudentIds = (allStudents ?? [])
    .map((student) => student.id)
    .filter((studentId) => !linkedStudentIds.has(studentId));

  if (orphanStudentIds.length > 0) {
    const { error: deleteStudentsError } = await supabase.from('students').delete().in('id', orphanStudentIds);
    if (deleteStudentsError) {
      return { ok: false as const, error: deleteStudentsError.message };
    }
  }

  revalidatePath('/');
  revalidatePath('/groups');
  revalidatePath('/students');
  revalidatePath('/teachers');
  revalidatePath('/courses');

  return {
    ok: true as const,
    deletedOrphanTeachers: orphanTeacherIds.length,
    deletedOrphanStudents: orphanStudentIds.length,
  };
}
