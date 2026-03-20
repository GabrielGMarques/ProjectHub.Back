import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { EmployeeService } from '../services/employee.service';
import { EmployeeLog } from '../models/employee-log.model';
import { TelemetryService } from '../services/telemetry.service';

const employeeService = new EmployeeService();
const telemetryService = new TelemetryService();

export class EmployeeController {

  async getRoles(_req: AuthRequest, res: Response): Promise<void> {
    res.json(employeeService.getRoleTemplates());
  }

  async hire(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { projectId, role, name } = req.body;
      if (!projectId || !role) { res.status(400).json({ error: 'projectId and role required' }); return; }
      const employee = await employeeService.hire(req.userId!, projectId, role, name);
      res.json(employee);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async fire(req: AuthRequest, res: Response): Promise<void> {
    try {
      await employeeService.fire(req.userId!, req.params.id);
      res.json({ message: 'Employee removed' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async getByProject(req: AuthRequest, res: Response): Promise<void> {
    const employees = await employeeService.getByProject(req.userId!, req.params.projectId);
    res.json(employees);
  }

  async getAll(req: AuthRequest, res: Response): Promise<void> {
    const employees = await employeeService.getAll(req.userId!);
    res.json(employees);
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    const employee = await employeeService.getById(req.userId!, req.params.id);
    if (!employee) { res.status(404).json({ error: 'Employee not found' }); return; }
    res.json(employee);
  }

  async assignTask(req: AuthRequest, res: Response): Promise<void> {
    const { task } = req.body;
    if (!task) { res.status(400).json({ error: 'task is required' }); return; }

    // SSE streaming
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    try {
      await employeeService.assignTask(req.userId!, req.params.id, task, (event) => {
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });
    } catch (error: any) {
      telemetryService.track({
        userId: req.userId!, employeeId: req.params.id,
        type: 'error', source: 'employee-controller', status: 'failed',
        description: task, error: error.message,
      });
      if (!clientDisconnected && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', content: error.message, sessionId: '', timestamp: new Date() })}\n\n`);
      }
    }
    if (!res.writableEnded) res.end();
  }

  async stopTask(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await employeeService.stopTask(req.userId!, req.params.id);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async sendMessage(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { message } = req.body;
      if (!message) { res.status(400).json({ error: 'message is required' }); return; }
      const result = await employeeService.sendMessage(req.userId!, req.params.id, message);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async getComms(req: AuthRequest, res: Response): Promise<void> {
    const comms = await employeeService.getComms(req.userId!, req.params.projectId);
    res.json(comms);
  }

  async addSkill(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { name, description, prompt } = req.body;
      if (!name) { res.status(400).json({ error: 'skill name required' }); return; }
      const employee = await employeeService.addSkill(req.userId!, req.params.id, {
        name, description: description || '', prompt: prompt || '',
      });
      res.json(employee);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async removeSkill(req: AuthRequest, res: Response): Promise<void> {
    try {
      const employee = await employeeService.removeSkill(req.userId!, req.params.id, req.params.skillName);
      res.json(employee);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async getRoleSkills(req: AuthRequest, res: Response): Promise<void> {
    const skills = await employeeService.getRoleSkills(req.userId!, req.params.role);
    res.json(skills);
  }

  async getLogs(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const category = req.query.category as string;
      const skip = (page - 1) * limit;

      const filter: any = { userId: req.userId!, employeeId: id };
      if (category) filter.category = category;

      const [logs, total] = await Promise.all([
        EmployeeLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        EmployeeLog.countDocuments(filter),
      ]);

      res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
