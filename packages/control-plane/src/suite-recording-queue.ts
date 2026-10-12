import type { SuiteCaseRunReference } from "./dispatch-worker-types.ts";

interface QueuedRecording {
  reference: SuiteCaseRunReference;
  resolve: () => void;
}

/** A Suite keeps at most two uploads active; duplicate ready events share one task. */
export class SuiteRecordingQueue {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly waiting: QueuedRecording[] = [];
  private active = 0;

  constructor(
    private readonly retain: (reference: SuiteCaseRunReference) => Promise<void>,
    private readonly onFailure: (reference: SuiteCaseRunReference, error: unknown) => Promise<void>,
  ) {}

  enqueue(reference: SuiteCaseRunReference): void {
    if (this.tasks.has(reference.caseRunId)) return;
    const task = new Promise<void>((resolve) => {
      this.waiting.push({ reference, resolve });
    });
    this.tasks.set(reference.caseRunId, task);
    this.pump();
  }

  async drain(): Promise<void> {
    await Promise.all(this.tasks.values());
  }

  private pump(): void {
    while (this.active < 2 && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) break;
      this.active += 1;
      void this.run(next);
    }
  }

  private async run(item: QueuedRecording): Promise<void> {
    try {
      await this.retain(item.reference);
    } catch (error) {
      await this.onFailure(item.reference, error).catch(() => undefined);
    } finally {
      this.active -= 1;
      item.resolve();
      this.pump();
    }
  }
}
