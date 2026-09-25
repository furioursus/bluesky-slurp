import type { APIRoute } from 'astro';
import { getJob, type JobEvent } from '../../../../lib/jobs.ts';

const encoder = new TextEncoder();
const frame = (event: JobEvent, index: number) => encoder.encode(`id: ${index}\ndata: ${JSON.stringify(event)}\n\n`);

export const GET: APIRoute = ({ params, request }) => {
  const job = getJob(params.id ?? '');
  if (!job) return Response.json({ error: 'no such job' }, { status: 404 });
  const resumeFrom = Number(request.headers.get('last-event-id') ?? -1) + 1;

  let listener: ((event: JobEvent, index: number) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      job.events.slice(resumeFrom).forEach((event, i) => controller.enqueue(frame(event, resumeFrom + i)));
      if (job.finished) return controller.close();
      listener = (event, index) => {
        controller.enqueue(frame(event, index));
        if (event.type === 'done' || event.type === 'error') {
          job.listeners.delete(listener!);
          controller.close();
        }
      };
      job.listeners.add(listener);
    },
    cancel() {
      if (listener) job.listeners.delete(listener);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
};
