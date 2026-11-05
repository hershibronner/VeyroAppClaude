// Domain event bus: emitted events are dispatched through the job queue to every registered listener
// (automations engine, outbound webhooks, ...). Listeners register with onEvent() from their module.
import { enqueue, registerJob } from '../jobs/queue';

export type EventListener = (orgId: string, event: string, payload: Record<string, unknown>) => Promise<void>;
const listeners: { name: string; fn: EventListener }[] = [];
export function onEvent(name: string, fn: EventListener) { listeners.push({ name, fn }); }

export async function emit(orgId: string, event: string, payload: Record<string, unknown>) {
  await enqueue('event.dispatch', { event, payload }, { orgId });
}

registerJob('event.dispatch', async (p, job) => {
  for (const l of listeners) {
    try { await l.fn(job.orgId!, p.event, p.payload); } catch (e: any) { console.error(`[event ${p.event} → ${l.name}]`, e?.message ?? e); }
  }
});
