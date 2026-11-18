// Generic bounded worker-pool runner used to cap PEAK concurrent load for
// opt-in parallel lanes (D — RC6 readiness re-fetch, E — deep second-pass
// discovery). This is deliberately NOT `Promise.all` over the whole input set:
// at most `concurrency` tasks are ever in flight at once, so a large budget can
// never spike peak load and re-trigger the 502/OOM class of failures.
//
// Guarantees:
//  - concurrency is floored at 1, so passing 0/NaN/negative → strictly serial.
//  - concurrency === 1 processes items strictly in index order, awaiting each —
//    i.e. byte-for-byte equivalent to a plain `for … await` loop.
//  - the per-item worker is invoked exactly once per item, with its index.
//  - never throws on a worker rejection path on the caller's behalf: callers are
//    expected to make `worker` non-throwing (catch inside), matching the serial
//    code it replaces. (If a worker does reject, the returned promise rejects.)
export async function runBoundedPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  if (items.length === 0) return;
  if (limit <= 1) {
    for (let i = 0; i < items.length; i++) {
      await worker(items[i], i);
    }
    return;
  }
  let next = 0;
  const effective = Math.min(limit, items.length);
  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      await worker(items[idx], idx);
    }
  };
  const runners: Promise<void>[] = [];
  for (let w = 0; w < effective; w++) runners.push(runOne());
  await Promise.all(runners);
}
