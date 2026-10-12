/** `map` with at most `limit` calls in flight, answering in the input's order. */
export async function mapConcurrent<Item, Result>(
  items: readonly Item[],
  limit: number,
  map: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  // One iterator shared by every worker: each takes the next item when it is free.
  const entries = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of entries) results[index] = await map(item, index);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
