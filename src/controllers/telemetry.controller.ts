import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { TelemetryService } from '../services/telemetry.service';
import { ManagerLog } from '../models/manager-log.model';
import { EmployeeLog } from '../models/employee-log.model';

const telemetryService = new TelemetryService();

export class TelemetryController {

  async getEvents(req: AuthRequest, res: Response): Promise<void> {
    const { type, status, source, projectId, limit, offset } = req.query;
    const result = await telemetryService.getEvents(req.userId!, {
      type: type as string,
      status: status as string,
      source: source as string,
      projectId: projectId as string,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });
    res.json(result);
  }

  async getStats(req: AuthRequest, res: Response): Promise<void> {
    const days = parseInt(req.query.days as string) || 7;
    const stats = await telemetryService.getStats(req.userId!, days);
    res.json(stats);
  }

  async getErrors(req: AuthRequest, res: Response): Promise<void> {
    const limit = parseInt(req.query.limit as string) || 50;
    const errors = await telemetryService.getErrors(req.userId!, limit);
    res.json(errors);
  }

  async getExecutionLog(req: AuthRequest, res: Response): Promise<void> {
    const hours = parseInt(req.query.hours as string) || 48;
    const result = await telemetryService.getExecutionLog(req.userId!, hours);
    res.json(result);
  }

  async getManagerLogs(req: AuthRequest, res: Response): Promise<void> {
    const category = req.query.category as string;
    const query: any = { userId: req.userId };
    if (category) query.category = category;

    const logs = await ManagerLog.find(query)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    // Stats
    const all = await ManagerLog.find({ userId: req.userId }).lean();
    const stats = {
      total: all.length,
      messages: all.filter(l => l.category === 'message').length,
      aiCalls: all.filter(l => l.category === 'ai_call').length,
      actions: all.filter(l => l.category === 'action').length,
      errors: all.filter(l => l.category === 'error').length,
      watchdog: all.filter(l => l.category === 'watchdog').length,
      loop: all.filter(l => l.category === 'loop').length,
      voice: all.filter(l => l.category === 'voice').length,
    };

    res.json({ logs, stats });
  }

  async getEmployeeLogs(req: AuthRequest, res: Response): Promise<void> {
    const { employeeId, category, projectId } = req.query;
    const query: any = { userId: req.userId };
    if (employeeId) query.employeeId = employeeId;
    if (category) query.category = category;
    if (projectId) query.projectId = projectId;

    const logs = await EmployeeLog.find(query)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    // Group by employee for the summary
    const all = await EmployeeLog.find({ userId: req.userId }).lean();
    const empMap = new Map<string, { name: string; avatar: string; role: string; projectName: string; total: number; errors: number; tasks: number }>();
    for (const l of all) {
      const key = l.employeeId.toString();
      if (!empMap.has(key)) {
        empMap.set(key, { name: l.employeeName, avatar: l.employeeAvatar, role: l.employeeRole, projectName: l.projectName, total: 0, errors: 0, tasks: 0 });
      }
      const e = empMap.get(key)!;
      e.total++;
      if (l.category === 'error' || l.category === 'task_fail') e.errors++;
      if (l.category === 'task_start') e.tasks++;
    }

    const employees = Array.from(empMap.entries()).map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.total - a.total);

    const stats = {
      total: all.length,
      taskStarts: all.filter(l => l.category === 'task_start').length,
      taskCompletes: all.filter(l => l.category === 'task_complete').length,
      taskFails: all.filter(l => l.category === 'task_fail').length,
      toolUses: all.filter(l => l.category === 'tool_use').length,
      errors: all.filter(l => l.category === 'error').length,
    };

    res.json({ logs, employees, stats });
  }
}
