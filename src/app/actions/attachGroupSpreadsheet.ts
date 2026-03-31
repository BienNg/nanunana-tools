'use server';

import { revalidatePath } from 'next/cache';
import { fetchSpreadsheetMetadata } from '@/lib/googleSheets/fetchSpreadsheetMetadata';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeForMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ');
}

/** Google often keeps `.xlsx` / `.xls` in the doc title after upload; group names usually omit it. */
function stripCommonDocTitleSuffixes(name: string): string {
  return name.replace(/\.(xlsx|xls|csv)$/i, '').trim();
}

function namesMatchForGroupLink(workbookTitle: string, groupName: string): boolean {
  return (
    normalizeForMatch(stripCommonDocTitleSuffixes(workbookTitle)) ===
    normalizeForMatch(stripCommonDocTitleSuffixes(groupName))
  );
}

function canonicalSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function tabUrl(spreadsheetId: string, sheetId: number): string {
  return `${canonicalSpreadsheetUrl(spreadsheetId)}#gid=${sheetId}`;
}

export type AttachGroupSpreadsheetResult =
  | {
      ok: true;
      spreadsheetUrl: string;
      linkedCourses: number;
      /** True when only the workbook URL was stored (Sheets API unavailable); mirrors import/sync without per-tab `gid`s. */
      workbookLinkedOnly: boolean;
    }
  | { ok: false; error: string; mismatches?: string[] };

function fail(error: string, mismatches?: string[]): AttachGroupSpreadsheetResult {
  return mismatches?.length ? { ok: false, error, mismatches } : { ok: false, error };
}

export async function attachGroupSpreadsheet(groupId: string, url: string): Promise<AttachGroupSpreadsheetResult> {
  if (!isValidUuid(groupId)) {
    return fail('Invalid group id.');
  }

  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return fail('Paste a Google Sheets URL.');
  }

  const supabase = getSupabaseAdmin();

  const { data: group, error: groupError } = await supabase
    .from('groups')
    .select('id, name, spreadsheet_url, spreadsheet_id')
    .eq('id', groupId)
    .single();

  if (groupError || !group) {
    return fail(groupError?.message ?? 'Group not found.');
  }

  if (String(group.spreadsheet_url ?? '').trim()) {
    return fail(
      'This group already has a spreadsheet URL. Remove it in the database if you need to replace it.'
    );
  }

  let meta: Awaited<ReturnType<typeof fetchSpreadsheetMetadata>>;
  try {
    meta = await fetchSpreadsheetMetadata(trimmedUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load spreadsheet.';
    const { data: hintCourses } = await supabase.from('courses').select('name').eq('group_id', groupId).order('name');
    const names = (hintCourses ?? []).map((c) => c.name);
    const mismatches: string[] = [
      `Could not read spreadsheet (API and Excel export both failed): ${message}`,
      `Group name in app: "${group.name}"`,
      names.length > 0
        ? `Courses in app (${names.length}): ${names.map((n) => `"${n}"`).join(', ')}`
        : 'No courses in this group yet.',
      'Fix sharing or convert the file to a native Google Sheet (File → Save as Google Sheets), then try again.',
    ];
    return fail(message, mismatches);
  }

  const { spreadsheetId, workbookTitle, visibleTabs } = meta;

  if (!namesMatchForGroupLink(workbookTitle, group.name)) {
    const wbNorm = normalizeForMatch(stripCommonDocTitleSuffixes(workbookTitle));
    const groupNorm = normalizeForMatch(stripCommonDocTitleSuffixes(group.name));
    return fail(
      `Spreadsheet title does not match the group name (extensions like .xlsx are ignored).`,
      [
        `Spreadsheet title in Google: "${workbookTitle}"`,
        `Group name in app: "${group.name}"`,
        `After normalizing for comparison: "${wbNorm}" vs "${groupNorm}"`,
      ]
    );
  }

  const { data: otherOwner, error: otherError } = await supabase
    .from('groups')
    .select('id')
    .eq('spreadsheet_id', spreadsheetId)
    .neq('id', groupId)
    .maybeSingle();

  if (otherError) {
    return fail(otherError.message);
  }
  if (otherOwner) {
    return fail('This spreadsheet is already linked to another group.', [
      `Spreadsheet id: ${spreadsheetId}`,
      'Another group row already references this spreadsheet_id.',
    ]);
  }

  const { data: courses, error: coursesError } = await supabase
    .from('courses')
    .select('id, name')
    .eq('group_id', groupId)
    .order('name');

  if (coursesError) {
    return fail(coursesError.message);
  }

  const courseRows = courses ?? [];

  if (courseRows.length > 0) {
    const courseByNorm = new Map<string, { id: string; name: string }>();
    for (const c of courseRows) {
      const k = normalizeForMatch(c.name);
      if (courseByNorm.has(k)) {
        return fail('This group has two or more courses that normalize to the same name.', [
          `Example duplicate key: "${k}"`,
          `Course names involved: "${courseByNorm.get(k)!.name}", "${c.name}"`,
        ]);
      }
      courseByNorm.set(k, { id: c.id, name: c.name });
    }

    const tabsByNorm = new Map<string, typeof visibleTabs>();
    for (const tab of visibleTabs) {
      const k = normalizeForMatch(tab.title);
      const list = tabsByNorm.get(k);
      if (list) list.push(tab);
      else tabsByNorm.set(k, [tab]);
    }

    for (const [k, list] of tabsByNorm) {
      if (list.length > 1 && courseByNorm.has(k)) {
        const labels = list.map((t) => `"${t.title}"`).join(', ');
        return fail(
          `Multiple visible tabs match the course name "${courseByNorm.get(k)!.name}" after normalization. There must be exactly one tab per course.`,
          [
            `Clashing tabs: ${labels}`,
            `Normalized key: "${k}"`,
          ]
        );
      }
    }

    const coursesWithoutTab = courseRows
      .filter((c) => !tabsByNorm.has(normalizeForMatch(c.name)))
      .map((c) => c.name);

    if (coursesWithoutTab.length > 0) {
      const mismatches: string[] = [
        `Visible tabs in spreadsheet (${visibleTabs.length}): ${visibleTabs.map((t) => `"${t.title}"`).join(', ') || '—'}`,
        `Courses in this group (${courseRows.length}): ${courseRows.map((c) => `"${c.name}"`).join(', ') || '—'}`,
        `Courses with no matching tab (each course needs one visible tab; extra tabs are ignored): ${coursesWithoutTab.map((n) => `"${n}"`).join(', ')}`,
      ];
      return fail(
        'Some courses in this group have no matching spreadsheet tab (after normalizing case and spaces).',
        mismatches
      );
    }
  }

  const spreadsheetUrl = canonicalSpreadsheetUrl(spreadsheetId);

  const { error: groupUpdateError } = await supabase
    .from('groups')
    .update({ spreadsheet_id: spreadsheetId, spreadsheet_url: spreadsheetUrl })
    .eq('id', groupId);

  if (groupUpdateError) {
    return fail(groupUpdateError.message);
  }

  /** Same as `syncOneCourseSheet` when `sheetUrl` is null: group URL only — Sheets API / gids unavailable. */
  let linkedCourses = 0;
  if (courseRows.length > 0 && meta.tabIdsFromApi) {
    const tabByNorm = new Map<string, (typeof visibleTabs)[0]>();
    for (const tab of visibleTabs) {
      tabByNorm.set(normalizeForMatch(tab.title), tab);
    }

    for (const c of courseRows) {
      const tab = tabByNorm.get(normalizeForMatch(c.name));
      if (!tab) continue;
      const sheetUrl = tabUrl(spreadsheetId, tab.sheetId);
      const { error: courseErr } = await supabase.from('courses').update({ sheet_url: sheetUrl }).eq('id', c.id);
      if (courseErr) {
        return fail(`Failed to set sheet URL for "${c.name}": ${courseErr.message}`);
      }
      linkedCourses++;
    }
  }

  revalidatePath('/groups');
  revalidatePath(`/groups/${groupId}`);
  revalidatePath('/courses');

  return {
    ok: true,
    spreadsheetUrl,
    linkedCourses,
    workbookLinkedOnly: !meta.tabIdsFromApi,
  };
}
