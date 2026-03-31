import { parseReviewedSnapshotImportPayload, runReviewedSnapshotSync } from '@/lib/sync/googleSheetSync';
import { revalidatePath } from 'next/cache';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let parsedPayload: ReturnType<typeof parseReviewedSnapshotImportPayload> | null = null;
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const bytes = Number(contentLengthHeader);
    // Keep a conservative guard so huge snapshot payloads fail with a clear message.
    if (Number.isFinite(bytes) && bytes > 8 * 1024 * 1024) {
      return Response.json(
        { error: 'Import payload is too large. Resync and import fewer tabs at once.' },
        { status: 413 }
      );
    }
  }
  try {
    const body = (await request.json()) as unknown;
    parsedPayload = parseReviewedSnapshotImportPayload(body);
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!parsedPayload || !parsedPayload.ok) {
    return Response.json({ error: parsedPayload?.error ?? 'Invalid request body' }, { status: 400 });
  }
  const { reviewSnapshot, skippedRowsBySheet, skippedAttendanceCellsBySheet, teacherAliasResolutions, workbookClassType } =
    parsedPayload.value;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        const result = await runReviewedSnapshotSync(reviewSnapshot, {
          skippedRowsBySheet,
          skippedAttendanceCellsBySheet,
          teacherAliasResolutions,
          workbookClassType,
          onProgress: (event) => {
            send({ event: 'progress', ...event });
          },
        });
        if (result.success) {
          // Ensure dashboard/group/course server components don't show stale completion pills after import.
          revalidatePath('/');
          revalidatePath('/groups');
          revalidatePath('/groups/[id]', 'page');
          revalidatePath('/courses/[id]', 'page');
        }
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
