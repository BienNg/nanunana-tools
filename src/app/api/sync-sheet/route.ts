import { runGoogleSheetSync } from '@/lib/sync/googleSheetSync';
import type { SkippedRowsBySheet, TeacherAliasResolution } from '@/lib/sync/googleSheetSync';

export const runtime = 'nodejs';

function parseTeacherAliasResolutions(raw: unknown): TeacherAliasResolution[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  const out: TeacherAliasResolution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const aliasName = typeof o.aliasName === 'string' ? o.aliasName.trim() : '';
    const teacherId = typeof o.teacherId === 'string' ? o.teacherId.trim() : '';
    if (!aliasName || !teacherId) continue;
    out.push({ aliasName, teacherId });
  }
  return out.length ? out : undefined;
}

export async function POST(request: Request) {
  let source: string | { fileName: string; bytes: Uint8Array } | null = null;
  let skippedRowsBySheet: SkippedRowsBySheet = {};
  let teacherAliasResolutions: TeacherAliasResolution[] | undefined;
  let workbookClassType: unknown;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      const skippedRaw = formData.get('skippedRowsBySheet');
      const aliasRaw = formData.get('teacherAliasResolutions');
      const classTypeRaw = formData.get('workbookClassType');
      if (typeof classTypeRaw === 'string' && classTypeRaw.trim()) {
        workbookClassType = classTypeRaw.trim();
      }
      if (file instanceof File) {
        if (!file.name.toLowerCase().endsWith('.xlsx')) {
          return Response.json({ error: 'Only .xlsx files are supported for file import' }, { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        source = { fileName: file.name, bytes };
      }
      if (typeof skippedRaw === 'string' && skippedRaw.trim()) {
        const parsed = JSON.parse(skippedRaw) as unknown;
        if (parsed && typeof parsed === 'object') {
          skippedRowsBySheet = parsed as SkippedRowsBySheet;
        }
      }
      if (typeof aliasRaw === 'string' && aliasRaw.trim()) {
        teacherAliasResolutions = parseTeacherAliasResolutions(JSON.parse(aliasRaw) as unknown);
      }
    } else {
      const body = (await request.json()) as {
        url?: string;
        skippedRowsBySheet?: unknown;
        teacherAliasResolutions?: unknown;
        workbookClassType?: unknown;
      };
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (url) source = url;
      if (body.skippedRowsBySheet && typeof body.skippedRowsBySheet === 'object') {
        skippedRowsBySheet = body.skippedRowsBySheet as SkippedRowsBySheet;
      }
      teacherAliasResolutions = parseTeacherAliasResolutions(body.teacherAliasResolutions);
      if (body.workbookClassType != null && body.workbookClassType !== '') {
        workbookClassType = body.workbookClassType;
      }
    }
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!source) {
    return Response.json({ error: 'Missing source (Google Sheets URL or .xlsx file)' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        const result = await runGoogleSheetSync(source, {
          skippedRowsBySheet,
          teacherAliasResolutions,
          workbookClassType,
          onProgress: (event) => {
            send({ event: 'progress', ...event });
          },
        });
        send({ event: 'done', result });
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Unknown error';
        send({ event: 'done', result: { success: false as const, error } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
