/**
 * A job's events, written behind in batches. A Suite Run appends a couple of
 * thousand events at a rate of about two a second, each of which used to be
 * one awaited transaction; over the job API each would be a round trip. So
 * an append queues and returns at once, and one batch at a time is written:
 * every 250 ms, or as soon as 200 events or 1 MiB are waiting. Only a full
 * backlog makes an append wait.
 *
 * A batch that failed is the end of the queue: nothing after it is written,
 * and the next append, and the next write that waits for the queue, rejects
 * with its error, which ends the run the way a failed event write did.
 */
const FLUSH_INTERVAL_MS = 250;
const FLUSH_EVENTS = 200;
const FLUSH_BYTES = 1024 * 1024;
const BACKLOG_EVENTS = 5_000;

export class EventQueue<Event> {
  readonly #write: (events: Event[]) => Promise<unknown>;
  #waiting: Array<{ event: Event; bytes: number }> = [];
  #waitingBytes = 0;
  #appended = 0;
  #written = 0;
  #batch: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #failure: Error | null = null;

  constructor(write: (events: Event[]) => Promise<unknown>) {
    this.#write = write;
  }

  /** Queues the event; waits only while the backlog is full. */
  async append(event: Event): Promise<void> {
    this.#rethrow();
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.#waiting.push({ event, bytes });
    this.#waitingBytes += bytes;
    this.#appended += 1;
    if (this.#batchIsDue()) this.#flush();
    else this.#schedule();
    while (this.#waiting.length >= BACKLOG_EVENTS && !this.#failure) {
      this.#flush();
      await this.#batch;
    }
    this.#rethrow();
  }

  /** Resolves once every event appended so far is written. */
  async written(): Promise<void> {
    const mark = this.#appended;
    while (this.#written < mark && !this.#failure) {
      this.#flush();
      await this.#batch;
    }
    this.#rethrow();
  }

  #rethrow(): void {
    if (this.#failure) throw this.#failure;
  }

  #batchIsDue(): boolean {
    return this.#waiting.length >= FLUSH_EVENTS || this.#waitingBytes >= FLUSH_BYTES;
  }

  #schedule(): void {
    // A batch in flight schedules the next one as it ends.
    if (this.#timer || this.#batch) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, FLUSH_INTERVAL_MS);
    this.#timer.unref();
  }

  /** Starts the next batch, unless one is in flight, nothing waits, or the queue has failed. */
  #flush(): void {
    if (this.#batch || this.#failure || this.#waiting.length === 0) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const events = this.#take();
    this.#batch = this.#write(events)
      .then(
        () => {
          this.#written += events.length;
        },
        (error: unknown) => {
          this.#failure = error instanceof Error ? error : new Error(String(error));
        },
      )
      .finally(() => {
        this.#batch = null;
        if (this.#batchIsDue()) this.#flush();
        else if (this.#waiting.length > 0) this.#schedule();
      });
  }

  /** The oldest waiting events, up to one batch: at least one, however large. */
  #take(): Event[] {
    let count = 0;
    let bytes = 0;
    for (const entry of this.#waiting) {
      if (count === FLUSH_EVENTS || (count > 0 && bytes + entry.bytes > FLUSH_BYTES)) break;
      count += 1;
      bytes += entry.bytes;
    }
    this.#waitingBytes -= bytes;
    return this.#waiting.splice(0, count).map((entry) => entry.event);
  }
}
