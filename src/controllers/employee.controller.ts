import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { EmployeeService } from '../services/employee.service';
import { Employee } from '../models/employee.model';
import { EmployeeLog } from '../models/employee-log.model';
import { TelemetryService } from '../services/telemetry.service';
import { ProjectService } from '../services/project.service';
import { employeeMemoryService } from '../services/employee-memory.service';
import { wsService } from '../services/websocket.service';
import { telegramBot } from '../services/telegram.service';
import { WorkingStatusHistory } from '../models/working-status-history.model';
import { DirectionHistory } from '../models/direction-history.model';
import { Project } from '../models/project.model';
import { managerService } from '../services/manager.service';

const employeeService = new EmployeeService();
const projectService = new ProjectService();
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

  /** GET /api/employees/local-skills — discover locally installed Claude Code skills */
  async getLocalSkills(_req: AuthRequest, res: Response): Promise<void> {
    const skills = employeeService.getLocalSkills();
    res.json(skills);
  }

  /** PUT /api/employees/role-skills/:role — batch set skills for a role (all employees of that type) */
  async setRoleSkills(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { role } = req.params;
      const { skills } = req.body; // array of { name, description, prompt? }
      if (!Array.isArray(skills)) { res.status(400).json({ error: 'skills array required' }); return; }
      const result = await employeeService.setRoleSkills(req.userId!, role, skills);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
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

  async getStatusHistory(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const skip = (page - 1) * limit;

      const [entries, total] = await Promise.all([
        WorkingStatusHistory.find({ employeeId: id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        WorkingStatusHistory.countDocuments({ employeeId: id }),
      ]);

      res.json({ entries, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Self-service status history — no auth, called by employee agents */
  async getSelfStatusHistory(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const entries = await WorkingStatusHistory.find({ employeeId: id })
        .sort({ createdAt: -1 }).limit(limit).lean();
      res.json({ entries });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Self-service: list all employees in the same company (no auth) */
  async getSelfTeam(req: AuthRequest, res: Response): Promise<void> {
    try {
      const emp = await Employee.findById(req.params.id).select('projectId').lean();
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
      const team = await Employee.find({ projectId: emp.projectId })
        .select('name title role avatar status workingStatus workingStatusAt lastActivity currentTask')
        .sort({ hiredAt: 1 }).lean();
      res.json(team);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Self-service: get working status of a specific teammate (no auth) */
  async getSelfTeammateStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const teammate = await Employee.findById(req.params.teammateId)
        .select('name title role avatar status workingStatus workingStatusAt taskHistory').lean();
      if (!teammate) { res.status(404).json({ error: 'Employee not found' }); return; }
      const statusHistory = await WorkingStatusHistory.find({ employeeId: req.params.teammateId })
        .sort({ createdAt: -1 }).limit(10).lean();
      res.json({
        name: teammate.name,
        title: teammate.title,
        role: teammate.role,
        status: teammate.status,
        workingStatus: teammate.workingStatus,
        workingStatusAt: teammate.workingStatusAt,
        taskHistory: (teammate.taskHistory || []).slice(-10).map((t: any) => ({
          taskId: t.taskId, description: t.description, status: t.status,
          result: t.result?.substring(0, 500), startedAt: t.startedAt, completedAt: t.completedAt,
        })),
        statusHistory: statusHistory.map((e: any) => ({
          content: e.content, source: e.source, createdAt: e.createdAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Self-service: get company direction + direction history (no auth) */
  async getSelfDirection(req: AuthRequest, res: Response): Promise<void> {
    try {
      const emp = await Employee.findById(req.params.id).select('projectId').lean();
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
      const project = await Project.findById(emp.projectId).select('name strategicDirection strategicCycle').lean();
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      const history = await DirectionHistory.find({ projectId: emp.projectId })
        .sort({ createdAt: -1 }).limit(20).lean();
      res.json({
        projectName: project.name,
        currentDirection: project.strategicDirection || '',
        cycle: project.strategicCycle,
        history: history.map((h: any) => ({
          content: h.content, source: h.source,
          authorName: h.authorName, authorRole: h.authorRole, createdAt: h.createdAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Self-service: CEO sets the company direction (no auth) */
  async setSelfDirection(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { direction } = req.body;
      if (!direction) { res.status(400).json({ error: 'direction is required' }); return; }
      const emp = await Employee.findById(req.params.id);
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
      const project = await Project.findByIdAndUpdate(
        emp.projectId, { strategicDirection: direction }, { new: true }
      );
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      DirectionHistory.create({
        userId: emp.userId.toString(), projectId: emp.projectId.toString(),
        projectName: project.name, content: direction,
        source: 'ceo', authorName: emp.name, authorRole: emp.role,
      }).catch(() => {});
      res.json({ message: `Direction updated for ${project.name}`, direction: project.strategicDirection });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // ── Memory endpoints ──

  async getMemories(req: AuthRequest, res: Response): Promise<void> {
    try {
      const memories = await employeeMemoryService.getMemories(
        req.params.id,
        req.query.category as string,
        parseInt(req.query.limit as string) || 50,
      );
      res.json(memories);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async addMemory(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { category, content, importance, tags } = req.body;
      if (!category || !content) { res.status(400).json({ error: 'category and content required' }); return; }
      const memory = await employeeMemoryService.addMemory(req.userId!, req.params.id, {
        category, content, importance, tags,
      });
      res.json(memory);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  async deleteMemory(req: AuthRequest, res: Response): Promise<void> {
    try {
      await employeeMemoryService.deleteMemory(req.userId!, req.params.memoryId);
      res.json({ message: 'Memory deleted' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async wipeMemories(req: AuthRequest, res: Response): Promise<void> {
    try {
      const count = await employeeMemoryService.wipeMemories(req.userId!, req.params.id);
      res.json({ message: `Wiped ${count} memories` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async compactLogs(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await employeeMemoryService.compactLogs(req.userId!, req.params.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async getDebugConfig(req: AuthRequest, res: Response): Promise<void> {
    try {
      const config = await employeeService.getDebugConfig(req.userId!, req.params.id);
      res.json(config);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  async clearSession(req: AuthRequest, res: Response): Promise<void> {
    try {
      const emp = await Employee.findById(req.params.id);
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
      const oldSession = emp.activeSessionId || emp.sdkSessionId || '(none)';
      emp.sdkSessionId = '';
      emp.activeSessionId = '';
      emp.currentTask = '';
      emp.status = 'idle';
      await emp.save();
      wsService.employeeStatusChanged(emp._id.toString(), emp.projectId.toString(), 'idle', emp.name);
      res.json({ message: `Session cleared for ${emp.name}. Old session: ${oldSession}` });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  async restartEmployee(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Force=true from HR panel — always kills session and boots fresh
      const result = await employeeService.restartEmployee(req.userId!, req.params.id, true);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** Employee sets their own status (called by the agent via API) */
  async selfSetStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { status } = req.body;
      if (!['idle', 'working'].includes(status)) {
        res.status(400).json({ error: 'status must be "idle" or "working"' }); return;
      }
      const emp = await Employee.findByIdAndUpdate(
        req.params.id,
        { status, lastActivity: new Date() },
        { new: true },
      );
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
      wsService.employeeStatusChanged(emp._id.toString(), emp.projectId.toString(), status, emp.name);
      if (status === 'idle') managerService.onEmployeeEvent(emp.name, 'idle');
      res.json({ message: `Status set to ${status}`, status: emp.status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Employee marks their current/latest task as done (called by the agent via API) */
  async selfTaskDone(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { taskId, result } = req.body;
      const emp = await Employee.findById(req.params.id);
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

      // Find the task — by taskId or the latest in_progress
      const task = taskId
        ? emp.taskHistory.find(t => t.taskId === taskId)
        : emp.taskHistory.filter(t => t.status === 'in_progress').pop();

      if (!task) { res.status(404).json({ error: 'No in_progress task found' }); return; }

      task.status = 'completed';
      task.completedAt = new Date();
      if (result) {
        task.result = result.substring(0, 5000);
        (task as any).resultUpdatedAt = new Date();
      }

      // Check if all tasks are done — set to idle
      const hasInProgress = emp.taskHistory.some(t => t.status === 'in_progress');
      if (!hasInProgress) {
        emp.status = 'idle';
        emp.currentTask = '';
      }
      emp.lastActivity = new Date();
      await emp.save();

      // Log and compact
      const uid = emp.userId.toString();
      const project = await projectService.findById(emp.projectId.toString(), uid);
      EmployeeLog.create({
        userId: uid, employeeId: emp._id.toString(), projectId: emp.projectId.toString(),
        category: 'task_complete', content: `✅ Self-reported: ${task.description}`,
        employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role,
        projectName: project?.name || 'Unknown',
      }).catch(() => {});

      employeeMemoryService.compactLogs(uid, emp._id.toString()).catch(() => {});

      wsService.employeeTaskUpdate(emp._id.toString(), emp.projectId.toString(), {
        taskId: task.taskId, status: task.status, result: task.result, description: task.description,
      });
      if (!hasInProgress) {
        wsService.employeeStatusChanged(emp._id.toString(), emp.projectId.toString(), emp.status, emp.name);
      }

      // Notify Telegram
      telegramBot.send(`✅ *${emp.name}* finished: "${task.description}"\n📋 _${project?.name || 'Unknown'}_`).catch(() => {});

      // Wake Alfred so he processes the completion immediately
      managerService.onEmployeeEvent(emp.name, 'task_done');

      res.json({
        message: `Task marked done: ${task.description}`,
        status: emp.status,
        allDone: !hasInProgress,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Employee updates the result/description of a task */
  async selfTaskUpdate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { taskId, result } = req.body;
      if (!result) { res.status(400).json({ error: 'result is required' }); return; }
      const emp = await Employee.findById(req.params.id);
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

      const task = taskId
        ? emp.taskHistory.find(t => t.taskId === taskId)
        : emp.taskHistory[emp.taskHistory.length - 1];

      if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

      task.result = result.substring(0, 5000);
      (task as any).resultUpdatedAt = new Date();
      await emp.save();

      wsService.employeeTaskUpdate(emp._id.toString(), emp.projectId.toString(), {
        taskId: task.taskId, status: task.status, result: task.result, description: task.description,
      });
      res.json({ message: `Task result updated: ${task.description}`, taskId: task.taskId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Employee updates their free-text working status (simple alternative to task-done/status calls) */
  async selfWorkingStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { status } = req.body;
      if (!status || typeof status !== 'string') {
        res.status(400).json({ error: 'status (string) is required' }); return;
      }

      const emp = await Employee.findById(req.params.id);
      if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

      emp.workingStatus = status.substring(0, 2000);
      emp.workingStatusAt = new Date();
      emp.workingStatusRead = false;
      emp.lastActivity = new Date();

      // Auto-detect idle intent from the status text
      const lowerStatus = status.toLowerCase();
      const idleSignals = ['idle', 'finished', 'done', 'completed', 'waiting for', 'nothing to do', 'all tasks done'];
      if (idleSignals.some(s => lowerStatus.includes(s)) && emp.status === 'working') {
        // Auto-complete in_progress tasks and set idle
        const inProgressTasks = emp.taskHistory.filter(t => t.status === 'in_progress');
        for (const task of inProgressTasks) {
          task.status = 'completed';
          task.completedAt = new Date();
          if (!task.result) task.result = status.substring(0, 5000);
        }
        emp.status = 'idle';
        emp.currentTask = '';

        // Notify on auto-completion
        const uid2 = emp.userId.toString();
        const proj2 = await projectService.findById(emp.projectId.toString(), uid2);
        telegramBot.send(`✅ *${emp.name}* is done (${inProgressTasks.length} task${inProgressTasks.length > 1 ? 's' : ''} completed)\n📋 _${proj2?.name || 'Unknown'}_`).catch(() => {});
        wsService.employeeStatusChanged(emp._id.toString(), emp.projectId.toString(), 'idle', emp.name);
        for (const task of inProgressTasks) {
          wsService.employeeTaskUpdate(emp._id.toString(), emp.projectId.toString(), {
            taskId: task.taskId, status: task.status, result: task.result, description: task.description,
          });
        }
      }

      await emp.save();

      const uid = emp.userId.toString();
      const project = await projectService.findById(emp.projectId.toString(), uid);

      // Save full working status to history
      const latestTask = emp.taskHistory[emp.taskHistory.length - 1];
      WorkingStatusHistory.create({
        userId: uid, employeeId: emp._id.toString(), projectId: emp.projectId.toString(),
        employeeName: emp.name, employeeRole: emp.role,
        content: status.substring(0, 5000),
        source: 'api',
        taskId: latestTask?.taskId,
      }).catch(() => {});

      EmployeeLog.create({
        userId: uid, employeeId: emp._id.toString(), projectId: emp.projectId.toString(),
        category: 'text', content: `📋 Working status: ${status.substring(0, 200)}`,
        employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role,
        projectName: project?.name || 'Unknown',
      }).catch(() => {});

      wsService.employeeStatusChanged(emp._id.toString(), emp.projectId.toString(), emp.status, emp.name);

      // Wake Alfred — idle transitions are high-priority, regular updates are informational
      managerService.onEmployeeEvent(emp.name, emp.status === 'idle' ? 'idle' : 'status_update');

      res.json({
        message: 'Working status updated',
        workingStatus: emp.workingStatus,
        employeeStatus: emp.status,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
