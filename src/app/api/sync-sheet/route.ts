import { runGoogleSheetSync } from '@/lib/sync/googleSheetSync';
import type { SkippedRowsBySheet } from '@/lib/sync/googleSheetSync';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let url: string;
  let skippedRowsBySheet: SkippedRowsBySheet = {};
  try {
    const body = (await request.json()) as { url?: string; skippedRowsBySheet?: unknown };
    url = typeof body.url === 'string' ? body.url.trim() : '';
    if (body.skippedRowsBySheet && typeof body.skippedRowsBySheet === 'object') {
      skippedRowsBySheet = body.skippedRowsBySheet as SkippedRowsBySheet;
    }
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!url) {
    return Response.json({ error: 'Missing url' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        const result = await runGoogleSheetSync(url, {
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
