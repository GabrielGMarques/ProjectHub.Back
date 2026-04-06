import { Employee } from '../models/employee.model';
import { EmployeeService } from './employee.service';

const employeeService = new EmployeeService();

const LOG_PREFIX = '[Heartbeat]';

/**
 * Heartbeat scheduler — runs a configured prompt for opt-in employees at a per-employee interval.
 *
 * - Scans every 1 minute for employees where heartbeatEnabled=true
 * - Skips employees currently working (won't pile up tasks)
 * - Marks lastHeartbeatAt BEFORE firing to avoid double-fire on slow ticks
 * - Fires the configured prompt via employeeService.assignTask (fire-and-forget)
 */
export class HeartbeatService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private static readonly CHECK_INTERVAL_MS = 60 * 1000; // scan every 1 minute

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick().catch((err) => {
      console.error(`${LOG_PREFIX} Tick error:`, err.message);
    }), HeartbeatService.CHECK_INTERVAL_MS);
    console.log(`${LOG_PREFIX} Service started — checking every 1min`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log(`${LOG_PREFIX} Service stopped`);
    }
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const employees = await Employee.find({ heartbeatEnabled: true }).lean();

    if (employees.length === 0) return;

    for (const emp of employees) {
      if (!emp.heartbeatPrompt?.trim()) continue;
      if (emp.status === 'working') continue;

      const interval = emp.heartbeatIntervalMs || (3 * 60 * 60 * 1000);
      const lastRun = emp.lastHeartbeatAt ? new Date(emp.lastHeartbeatAt).getTime() : 0;
      if (now - lastRun < interval) continue;

      // Mark first to prevent double-fire if assignTask is slow
      await Employee.updateOne({ _id: emp._id }, { lastHeartbeatAt: new Date() });

      const intervalMin = Math.round(interval / 60000);
      console.log(`${LOG_PREFIX} Firing for ${emp.name} (${emp._id}) — interval ${intervalMin}min`);

      // Fire-and-forget — assignTask runs the prompt as a regular task
      employeeService
        .assignTask(
          emp.userId.toString(),
          emp._id.toString(),
          `[HEARTBEAT] ${emp.heartbeatPrompt}`,
          () => {},
        )
        .catch((err) => {
          console.error(`${LOG_PREFIX} ${emp.name} failed:`, err.message);
        });
    }
  }
}

export const heartbeatService = new HeartbeatService();
