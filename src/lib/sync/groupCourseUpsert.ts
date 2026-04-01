import type { GroupClassType } from '@/lib/courseDuration';
import { courseDbUrlMatchesTabUrl } from '@/lib/sync/googleSheetReimportDiff';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

type DbProgressEvent = { type: 'db'; message: string };
type ProgressReporter = (event: DbProgressEvent) => void | Promise<void>;

export type UpsertedGroup = {
  id: string;
  name?: string | null;
  class_type?: string | null;
  spreadsheet_url?: string | null;
};

/** PostgREST when the column was never migrated / not in schema cache yet. */
export function isSupabaseMissingColumnError(message: string | undefined, column: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const col = column.toLowerCase();
  return m.includes(col) && (m.includes('schema cache') || m.includes('could not find'));
}

export async function upsertGroupBySpreadsheetId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  params: {
    spreadsheetId: string;
    workbookTitle: string;
    classType: GroupClassType;
    spreadsheetUrl: string | null;
    onProgress?: ProgressReporter;
  }
): Promise<UpsertedGroup> {
  const { spreadsheetId, workbookTitle, classType, spreadsheetUrl, onProgress } = params;

  await onProgress?.({ type: 'db', message: 'groups — select by spreadsheet_id' });
  const { data: existingGroup, error: groupSelectError } = await supabase
    .from('groups')
    .select('id, name, class_type, spreadsheet_url')
    .eq('spreadsheet_id', spreadsheetId)
    .maybeSingle();
  if (groupSelectError) throw new Error(groupSelectError.message);

  let group: UpsertedGroup | null = existingGroup;
  if (!group) {
    await onProgress?.({ type: 'db', message: 'groups — insert' });
    const baseGroup = {
      name: workbookTitle,
      spreadsheet_id: spreadsheetId,
      class_type: classType,
    };
    let inserted: UpsertedGroup | null = null;
    let insertErr: { message: string } | null = null;
    ({ data: inserted, error: insertErr } = await supabase
      .from('groups')
      .insert({ ...baseGroup, spreadsheet_url: spreadsheetUrl })
      .select('id')
      .single());
    if (insertErr && isSupabaseMissingColumnError(insertErr.message, 'spreadsheet_url')) {
      ({ data: inserted, error: insertErr } = await supabase.from('groups').insert(baseGroup).select('id').single());
    }
    if (insertErr || !inserted) {
      throw new Error(`Failed to create group: ${insertErr?.message ?? 'unknown'}`);
    }
    group = inserted;
  } else {
    const prevName = (existingGroup?.name ?? '').trim();
    const prevClass = existingGroup?.class_type ?? null;
    const prevUrl = (existingGroup?.spreadsheet_url ?? '').trim();
    const nextUrl = (spreadsheetUrl ?? '').trim();
    const groupNeedsUpdate =
      prevName !== workbookTitle.trim() ||
      prevClass !== classType ||
      (spreadsheetUrl != null && prevUrl !== nextUrl);

    if (groupNeedsUpdate) {
      await onProgress?.({ type: 'db', message: 'groups — update changed fields' });
      if (spreadsheetUrl) {
        const { error: upErr } = await supabase
          .from('groups')
          .update({
            name: workbookTitle,
            class_type: classType,
            spreadsheet_url: spreadsheetUrl,
          })
          .eq('id', group.id);
        if (upErr && isSupabaseMissingColumnError(upErr.message, 'spreadsheet_url')) {
          const { error: up2 } = await supabase
            .from('groups')
            .update({ name: workbookTitle, class_type: classType })
            .eq('id', group.id);
          if (up2) throw new Error(up2.message);
        } else if (upErr) {
          throw new Error(upErr.message);
        }
      } else {
        const { error: upErr } = await supabase
          .from('groups')
          .update({ name: workbookTitle, class_type: classType })
          .eq('id', group.id);
        if (upErr) throw new Error(upErr.message);
      }
    }
  }

  if (!group) throw new Error('Internal error: group not resolved after insert/select');
  return group;
}

export async function upsertCourseInGroup(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  params: {
    groupId: string;
    courseName: string;
    sheetUrl: string | null;
    progressLabel: string;
    onProgress?: ProgressReporter;
  }
): Promise<{ courseId: string }> {
  const { groupId, courseName, sheetUrl, progressLabel, onProgress } = params;

  await onProgress?.({
    type: 'db',
    message: `${progressLabel} courses — select by group + name`,
  });
  const { data: existingCourses, error: existingCoursesErr } = await supabase
    .from('courses')
    .select('id, sheet_url')
    .eq('group_id', groupId)
    .eq('name', courseName);
  if (existingCoursesErr) throw new Error(existingCoursesErr.message);

  let courseId: string;
  let existing: { id: string; sheet_url: string | null } | null = null;
  if ((existingCourses ?? []).length === 1) {
    existing = existingCourses![0] as { id: string; sheet_url: string | null };
  } else if ((existingCourses ?? []).length > 1) {
    const rows = (existingCourses ?? []) as { id: string; sheet_url: string | null }[];
    if (sheetUrl) {
      existing = rows.find((c) => courseDbUrlMatchesTabUrl(c.sheet_url, sheetUrl)) ?? null;
    }
    if (!existing) {
      existing = rows.find((c) => !(c.sheet_url ?? '').trim()) ?? rows[0] ?? null;
    }
  }

  if (existing?.id) {
    courseId = existing.id;
    const prevUrl = (existing.sheet_url ?? '').trim();
    const nextUrl = (sheetUrl ?? '').trim();
    if (sheetUrl && prevUrl !== nextUrl) {
      await onProgress?.({
        type: 'db',
        message: `${progressLabel} courses — update sheet_url`,
      });
      const { error: sheetUrlErr } = await supabase.from('courses').update({ sheet_url: sheetUrl }).eq('id', courseId);
      if (sheetUrlErr && !isSupabaseMissingColumnError(sheetUrlErr.message, 'sheet_url')) {
        throw new Error(`Failed to update course sheet_url "${courseName}": ${sheetUrlErr.message}`);
      }
    }
  } else {
    await onProgress?.({
      type: 'db',
      message: `${progressLabel} courses — insert`,
    });
    let row: { id: string } | null = null;
    let createError = null as { message: string } | null;
    ({ data: row, error: createError } = await supabase
      .from('courses')
      .insert({ name: courseName, group_id: groupId, sheet_url: sheetUrl })
      .select('id')
      .single());
    if (createError && isSupabaseMissingColumnError(createError.message, 'sheet_url')) {
      ({ data: row, error: createError } = await supabase
        .from('courses')
        .insert({ name: courseName, group_id: groupId })
        .select('id')
        .single());
    }
    if (createError || !row) {
      throw new Error(`Failed to create course "${courseName}": ${createError?.message ?? 'unknown'}`);
    }
    courseId = row.id;
  }

  return { courseId };
}
