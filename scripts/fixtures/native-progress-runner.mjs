// This runner is configured ONLY by the owned progress fixture. Database and
// product runners retain their default configuration and original budgets.
import { TestRunner } from 'vitest';
import { createNativeProgressPublisher } from './native-progress-publisher.mjs';

export default class ProgressFixtureRunner extends TestRunner {
  onAfterRunTask(task) {
    super.onAfterRunTask(task);
    this.publisher ??= createNativeProgressPublisher((tasks, events) =>
      this.onTaskUpdate(tasks, events),
    );
    // Keep the later blocked test independent of parent reporter delay. The
    // real RPC still supplies the real native result to VerboseReporter.
    void this.publisher(task).catch(() => console.error('NATIVE_PROGRESS_SENDER_FAILED'));
  }
}
