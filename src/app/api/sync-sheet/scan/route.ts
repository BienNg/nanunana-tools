export async function POST(request: Request) {
  let url = '';
  try {
    const body = (await request.json()) as { url?: string };
    url = typeof body.url === 'string' ? body.url.trim() : '';
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!url) {
    return Response.json({ error: 'Missing Google Sheets URL' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  // import dynamically so we only load sheets/googleapis on server
  const { scanGoogleSheet } = await import('@/lib/sync/googleSheetSync');

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        const result = await scanGoogleSheet(url, {
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
