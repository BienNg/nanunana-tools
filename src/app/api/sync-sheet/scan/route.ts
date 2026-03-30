export async function POST(request: Request) {
  let source: string | { fileName: string; bytes: Uint8Array } | null = null;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      if (file instanceof File) {
        if (!file.name.toLowerCase().endsWith('.xlsx')) {
          return Response.json({ error: 'Only .xlsx files are supported for file import' }, { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        source = { fileName: file.name, bytes };
      }
    } else {
      const body = (await request.json()) as { url?: string };
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (url) source = url;
    }
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!source) {
    return Response.json({ error: 'Missing source (Google Sheets URL or .xlsx file)' }, { status: 400 });
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
        const result = await scanGoogleSheet(source, {
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
