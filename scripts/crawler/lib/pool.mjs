// Runs `worker(item, index)` over `items` with at most `concurrency` in flight.
// Results keep input order; a worker that throws yields { error } instead of aborting the run.
export async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { value: await worker(items[i], i) }; }
      catch (error) { results[i] = { error }; }
    }
  });
  await Promise.all(lanes);
  return results;
}
