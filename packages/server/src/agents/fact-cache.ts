/** Bounded, successful-result-only cache. Pending reads coalesce across agents, never across identities. */
export class FactCache {
  private values = new Map<string, { value: unknown; expires: number; fetchedAt: number; bytes: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  constructor(
    private ttlMs = 60_000,
    private maxBytes = 16 * 1024 * 1024,
    private maxEntries = 256,
  ) {}

  async read<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.values.get(key);
    if (existing && existing.expires > Date.now()) {
      this.values.delete(key);
      this.values.set(key, existing);
      return structuredClone(existing.value) as T;
    }
    if (existing) this.remove(key);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = loader().then((value) => {
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null');
        if (bytes <= this.maxBytes) {
          while (this.values.size && (this.bytes + bytes > this.maxBytes || this.values.size >= this.maxEntries)) this.remove(this.values.keys().next().value!);
          this.values.set(key, { value: structuredClone(value), fetchedAt: Date.now(), expires: Date.now() + this.ttlMs, bytes });
          this.bytes += bytes;
        }
        return value;
      });
      this.pending.set(key, pending);
      const cleanup = () => {
        this.pending.delete(key);
      };
      void pending.then(cleanup, cleanup);
    }
    return structuredClone(await pending) as T;
  }
  private remove(key: string): void {
    this.bytes -= this.values.get(key)?.bytes ?? 0;
    this.values.delete(key);
  }
  fetchedAt(key: string): number | undefined {
    return this.values.get(key)?.fetchedAt;
  }
}

export class OrgReadLimiter {
  private queues = new Map<string, { active: number; waiters: (() => void)[] }>();
  constructor(private limit = 3) {}
  async run<T>(orgId: string, work: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(orgId) ?? { active: 0, waiters: [] };
    this.queues.set(orgId, queue);
    if (queue.active >= this.limit) await new Promise<void>((resolve) => queue.waiters.push(resolve));
    else queue.active++;
    try {
      return await work();
    } finally {
      const next = queue.waiters.shift();
      if (next) next();
      else {
        queue.active--;
        if (!queue.active) this.queues.delete(orgId);
      }
    }
  }
}
