/**
 * Tool-call scheduling.
 *
 * A model turn can contain several tool calls. Running them all through one `Promise.all` is wrong:
 * two writes to the same workspace path race, two gated commands open two confirmation cards at
 * once, and a validation started next to a write may or may not see it. Instead we partition the
 * calls — preserving the order the model emitted them — into contiguous batches of
 * concurrency-safe and concurrency-unsafe calls. Safe batches run in parallel (bounded), unsafe
 * batches run one at a time. Results are always returned in the original order so the model's view
 * of its own turn stays deterministic.
 */

export interface Batch<T> {
  safe: boolean;
  items: T[];
}

/** Group consecutive items with the same safety into batches, preserving order. */
export function partitionBySafety<T>(items: T[], isSafe: (item: T) => boolean): Batch<T>[] {
  const batches: Batch<T>[] = [];
  for (const item of items) {
    const safe = isSafe(item);
    const last = batches[batches.length - 1];
    if (last && last.safe === safe && safe) last.items.push(item);
    else batches.push({ safe, items: [item] });
  }
  return batches;
}

/** Run `fn` over items with at most `limit` in flight, resolving to results in input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Execute tool calls with safety-aware scheduling. Unsafe calls are serialised in emission order;
 * runs of safe calls go in parallel up to `limit`. Results come back in the original order.
 */
export async function runScheduled<T, R>(
  items: T[],
  opts: {
    isSafe: (item: T) => boolean;
    limit?: number;
    run: (item: T, index: number) => Promise<R>;
    shouldStop?: () => boolean;
    onSkipped?: (item: T, index: number) => R;
  },
): Promise<R[]> {
  const indexed = items.map((item, index) => ({ item, index }));
  const results = new Array<R>(items.length);
  for (const batch of partitionBySafety(indexed, (e) => opts.isSafe(e.item))) {
    if (opts.shouldStop?.() && opts.onSkipped) {
      for (const e of batch.items) results[e.index] = opts.onSkipped(e.item, e.index);
      continue;
    }
    if (batch.safe && batch.items.length > 1) {
      const out = await mapWithConcurrency(batch.items, opts.limit ?? 6, (e) => opts.run(e.item, e.index));
      batch.items.forEach((e, i) => {
        results[e.index] = out[i];
      });
    } else {
      for (const e of batch.items) {
        if (opts.shouldStop?.() && opts.onSkipped) {
          results[e.index] = opts.onSkipped(e.item, e.index);
          continue;
        }
        results[e.index] = await opts.run(e.item, e.index);
      }
    }
  }
  return results;
}
