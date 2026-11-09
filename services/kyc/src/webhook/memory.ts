// In-memory seen-event store for tests and local runs. Cases and audit rows use the shared
// in-memory store (src/store/memory.ts) through webhookCaseStore() (src/store/views.ts).
import type { SeenEventStore } from './ports';

interface SeenItem {
  state: 'processing' | 'done';
  leaseUntil: number;
  expiresAt: number;
}

export class MemorySeenEventStore implements SeenEventStore {
  private readonly items = new Map<string, SeenItem>();

  async claim(eventId: string, now: number, leaseMs: number, ttlMs: number): Promise<'claimed' | 'duplicate'> {
    const cur = this.items.get(eventId);
    const expired = cur !== undefined && cur.expiresAt <= now;
    const leaseOver = cur !== undefined && cur.state === 'processing' && cur.leaseUntil < now;
    if (cur && !expired && !leaseOver) return 'duplicate';
    this.items.set(eventId, { state: 'processing', leaseUntil: now + leaseMs, expiresAt: now + ttlMs });
    return 'claimed';
  }

  async complete(eventId: string, now: number, ttlMs: number): Promise<void> {
    this.items.set(eventId, { state: 'done', leaseUntil: 0, expiresAt: now + ttlMs });
  }

  async release(eventId: string): Promise<void> {
    if (this.items.get(eventId)?.state === 'processing') this.items.delete(eventId);
  }

  /** @internal test hook */
  state(eventId: string): SeenItem['state'] | undefined {
    return this.items.get(eventId)?.state;
  }
}
