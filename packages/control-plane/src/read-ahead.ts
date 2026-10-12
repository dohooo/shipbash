/**
 * Reads `items` with up to `width` reads in flight and yields the results in
 * the order of `items`. A read that fails ends the iteration with its error;
 * reads still in flight are left to finish unobserved.
 */
export async function* readAhead<Item, Result>(
  items: readonly Item[],
  read: (item: Item) => Promise<Result>,
  width: number,
): AsyncGenerator<Result> {
  const iterator = items.values();
  const pending: Array<Promise<Result>> = [];
  const fill = (): void => {
    while (pending.length < width) {
      const step = iterator.next();
      if (step.done) return;
      const started = read(step.value);
      // A read that fails while an earlier one is awaited is not unhandled: it is raised when its turn comes.
      started.catch(() => undefined);
      pending.push(started);
    }
  };
  fill();
  for (let head = pending.shift(); head; head = pending.shift()) {
    yield await head;
    fill();
  }
}
