import { runGoogleSheetSync } from '@/lib/sync/googleSheetSync';
import type { SkippedRowsBySheet } from '@/lib/sync/googleSheetSync';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let source: string | { fileName: string; bytes: Uint8Array } | null = null;
  let skippedRowsBySheet: SkippedRowsBySheet = {};
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      const skippedRaw = formData.get('skippedRowsBySheet');
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
    } else {
      const body = (await request.json()) as { url?: string; skippedRowsBySheet?: unknown };
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (url) source = url;
      if (body.skippedRowsBySheet && typeof body.skippedRowsBySheet === 'object') {
        skippedRowsBySheet = body.skippedRowsBySheet as SkippedRowsBySheet;
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
