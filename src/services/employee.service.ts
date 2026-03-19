import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Employee, IEmployee, IEmployeeSkill, UserRoleSkills, ROLE_TEMPLATES, RoleTemplate } from '../models/employee.model';
import { EmployeeLog } from '../models/employee-log.model';
import { ClaudeCodeService } from './claude-code.service';
import { telegramBot } from './telegram.service';
import { TelemetryService } from './telemetry.service';
import { ProjectService } from './project.service';

const claudeCodeService = new ClaudeCodeService();
const telegramService = telegramBot;
const telemetryService = new TelemetryService();
const projectService = new ProjectService();

function empLog(
  userId: string, employeeId: string, projectId: string,
  category: 'task_start' | 'task_complete' | 'task_fail' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'comms',
  content: string,
  emp: { name: string; avatar: string; role: string },
  projectName: string,
  metadata?: Record<string, any>
): void {
  EmployeeLog.create({
    userId, employeeId, projectId, category, content,
    employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role,
    projectName, metadata,
  }).catch(() => {});
}

export class EmployeeService {

  getRoleTemplates(): RoleTemplate[] {
    return ROLE_TEMPLATES;
  }

  async hire(userId: string, projectId: string, role: string, customName?: string): Promise<IEmployee> {
    const template = ROLE_TEMPLATES.find(r => r.role === role);
    if (!template) throw new Error(`Unknown role: ${role}`);

    const project = await projectService.findById(projectId, userId);
    if (!project) throw new Error('Project not found');

    // Load persisted skills for this role
    const roleSkills = await UserRoleSkills.findOne({ userId, role });
    const persistedSkills = roleSkills?.skills || [];

    const employee = await Employee.create({
      userId,
      projectId,
      role: template.role,
      name: customName || template.title,
      title: template.title,
      avatar: template.avatar,
      description: template.description,
      specialties: template.specialties,
      allowedTools: template.defaultTools,
      skills: persistedSkills,
      systemPrompt: template.systemPrompt,
      status: 'idle',
      taskHistory: [],
      hiredAt: new Date(),
    });

    // Create comms directory in project
    this.ensureCommsDir(project);

    telegramService.notifyHired(employee.name, project.name).catch(() => {});

    return employee;
  }

  async fire(userId: string, employeeId: string): Promise<void> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    const project = await projectService.findById(employee.projectId.toString(), userId);
    const projectName = project?.name || 'Unknown';

    // Cancel any running task
    if (employee.status === 'working') {
      claudeCodeService.cancelSession(employee.currentTask || '');
    }

    await Employee.deleteOne({ _id: employeeId });
    telegramService.notifyFired(employee.name, projectName).catch(() => {});
  }

  async getByProject(userId: string, projectId: string): Promise<IEmployee[]> {
    return Employee.find({ userId, projectId }).sort({ hiredAt: 1 });
  }

  async getAll(userId: string): Promise<IEmployee[]> {
    return Employee.find({ userId }).sort({ hiredAt: 1 });
  }

  async getById(userId: string, employeeId: string): Promise<IEmployee | null> {
    return Employee.findOne({ _id: employeeId, userId });
  }

  async assignTask(
    userId: string,
    employeeId: string,
    task: string,
    onEvent: (event: any) => void
  ): Promise<{ status: string }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');
    if (employee.status === 'working') throw new Error('Employee is already working on a task');

    const project = await projectService.findById(employee.projectId.toString(), userId);
    if (!project) throw new Error('Project not found');

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];

    const taskId = crypto.randomUUID();

    // Record task in history immediately (even if it fails right away)
    employee.status = 'working';
    employee.currentTask = taskId;
    employee.lastActivity = new Date();
    employee.taskHistory.push({
      taskId,
      description: task,
      status: 'in_progress',
      startedAt: new Date(),
    });
    await employee.save();

    // Validate cwd AFTER saving task to history so the failure is recorded
    if (!cwd) {
      const fresh = await Employee.findById(employeeId);
      if (fresh) {
        const entry = fresh.taskHistory.find(t => t.taskId === taskId);
        if (entry) { entry.status = 'failed'; entry.result = 'Project has no folders configured'; entry.completedAt = new Date(); }
        fresh.status = 'idle';
        fresh.currentTask = '';
        await fresh.save();
      }
      telemetryService.track({
        userId, projectId: employee.projectId.toString(), employeeId: employee._id.toString(),
        type: 'error', source: `employee:${employee.role}`, status: 'failed',
        description: task, error: 'Project has no folders configured',
      });
      throw new Error('Project has no folders configured. Add folders in project Settings tab.');
    }

    const empInfo = { name: employee.name, avatar: employee.avatar, role: employee.role };
    const pName = project.name;
    const pId = employee.projectId.toString();
    const eId = employee._id.toString();

    empLog(userId, eId, pId, 'task_start', task, empInfo, pName, { taskId });

    telegramService.notifyTaskStarted(employee.name, project.name, task).catch(() => {});
    const startTime = Date.now();
    telemetryService.track({
      userId, projectId: pId, employeeId: eId,
      type: 'employee_task', source: `employee:${employee.role}`, status: 'started',
      description: task,
    });

    // Ensure comms directory
    this.ensureCommsDir(project);

    // Build the agent prompt with role context + comms access
    // Normalize all paths to forward slashes — prevents agent confusion on Windows
    const normCwd = cwd.replace(/\\/g, '/');
    const normFolders = allFolders.map(f => f.replace(/\\/g, '/'));
    const commsDir = `${normCwd}/.agents/comms`;
    const teamMembers = await Employee.find({ projectId: project._id, userId, _id: { $ne: employee._id } });
    const teamList = teamMembers.map(m => `- ${m.avatar} ${m.name} (${m.title})`).join('\n') || 'None';

    const prompt = `${employee.systemPrompt}

PROJECT: ${project.name}
${project.description ? `DESCRIPTION: ${project.description}` : ''}
WORKING DIRECTORY: ${normCwd}
${normFolders.length > 1 ? `ALL PROJECT FOLDERS:\n${normFolders.map(f => `  - ${f}`).join('\n')}` : ''}

IMPORTANT FILE RULES:
- Always use forward slashes (/) in file paths, never backslashes.
- Always create files relative to the working directory above.
- When creating new files, use the Write tool with the full absolute path.
- Before writing to a directory, make sure it exists (use Bash: mkdir -p path/to/dir).

TEAM MEMBERS:
${teamList}

COMMUNICATION:
- Read messages from team: check files in ${commsDir}/
- Write your updates: create/update files in ${commsDir}/ named like "${employee.role}-update.md" or "${employee.role}-to-<role>.md"
- Always check .agents/comms/ for messages from other team members before starting work
- Write a brief status update in .agents/comms/${employee.role}-status.md when you finish

YOUR TASK:
${task}`;

    try {
      const result = await claudeCodeService.runCommand(cwd, prompt, (event) => {
        // Log every SDK event to employee logs
        if (event.type === 'tool_use') {
          empLog(userId, eId, pId, 'tool_use', `${event.tool}: ${(event.content || '').substring(0, 300)}`, empInfo, pName, { tool: event.tool });
        } else if (event.type === 'tool_result') {
          empLog(userId, eId, pId, 'tool_result', (event.content || '').substring(0, 500), empInfo, pName);
        } else if (event.type === 'text') {
          empLog(userId, eId, pId, 'text', (event.content || '').substring(0, 1000), empInfo, pName);
        } else if (event.type === 'error') {
          empLog(userId, eId, pId, 'error', event.content || 'Unknown error', empInfo, pName);
        }
        // Forward to original callback
        onEvent(event);
      }, {
        allowedTools: employee.allowedTools?.length ? employee.allowedTools : undefined,
      });

      // Re-fetch employee from DB (may have been modified during long SDK call)
      const fresh = await Employee.findById(employeeId);
      if (fresh) {
        const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
        if (taskEntry) {
          taskEntry.status = result.status === 'completed' ? 'completed' : 'failed';
          taskEntry.completedAt = new Date();
          const textEvents = result.events.filter(e => e.type === 'text').map(e => e.content).join('\n');
          taskEntry.result = textEvents.substring(0, 5000);
        }
        fresh.status = 'idle';
        fresh.currentTask = '';
        fresh.lastActivity = new Date();
        await fresh.save();
      }

      const duration = Date.now() - startTime;
      telemetryService.track({
        userId, projectId: employee.projectId.toString(), employeeId: employee._id.toString(),
        type: 'employee_task', source: `employee:${employee.role}`,
        status: result.status === 'completed' ? 'completed' : 'failed',
        description: task, durationMs: duration,
        error: result.status !== 'completed' ? result.status : undefined,
      });

      if (result.status === 'completed') {
        empLog(userId, eId, pId, 'task_complete', `Task completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s: ${task}`, empInfo, pName, { durationMs: Date.now() - startTime, taskId });
        telegramService.notifyTaskCompleted(employee.name, project.name, task).catch(() => {});
      } else {
        empLog(userId, eId, pId, 'task_fail', `Task failed (${result.status}): ${task}`, empInfo, pName, { durationMs: Date.now() - startTime, taskId, status: result.status });
        telegramService.notifyTaskFailed(employee.name, project.name, task, result.status).catch(() => {});
      }

      return { status: result.status };
    } catch (error: any) {
      // Re-fetch employee from DB to avoid stale doc
      const fresh = await Employee.findById(employeeId);
      if (fresh) {
        const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
        if (taskEntry) {
          taskEntry.status = 'failed';
          taskEntry.result = error.message;
          taskEntry.completedAt = new Date();
        }
        fresh.status = 'idle';
        fresh.currentTask = '';
        await fresh.save();
      }

      empLog(userId, eId, pId, 'error', `Task crashed: ${error.message}`, empInfo, pName, { durationMs: Date.now() - startTime, taskId, stack: error.stack?.substring(0, 500) });
      telemetryService.track({
        userId, projectId: pId, employeeId: eId,
        type: 'error', source: `employee:${employee.role}`, status: 'failed',
        description: task, error: error.message, durationMs: Date.now() - startTime,
      });
      telegramService.notifyTaskFailed(employee.name, project.name, task, error.message).catch(() => {});
      throw error;
    }
  }

  async getComms(userId: string, projectId: string): Promise<{ name: string; content: string; modified: string }[]> {
    const project = await projectService.findById(projectId, userId);
    if (!project) return [];

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) return [];

    const commsDir = path.join(cwd, '.agents', 'comms');
    if (!fs.existsSync(commsDir)) return [];

    const files = fs.readdirSync(commsDir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const filePath = path.join(commsDir, f);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      return { name: f, content, modified: stat.mtime.toISOString() };
    }).sort((a, b) => b.modified.localeCompare(a.modified));
  }

  // ── Skills management ──

  async addSkill(userId: string, employeeId: string, skill: IEmployeeSkill): Promise<IEmployee> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    // Add to employee
    if (!employee.skills.some(s => s.name === skill.name)) {
      employee.skills.push(skill);
      await employee.save();
    }

    // Persist to role level
    await UserRoleSkills.findOneAndUpdate(
      { userId, role: employee.role },
      { $addToSet: { skills: skill } },
      { upsert: true }
    );

    return employee;
  }

  async removeSkill(userId: string, employeeId: string, skillName: string): Promise<IEmployee> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    employee.skills = employee.skills.filter(s => s.name !== skillName);
    await employee.save();

    // Also remove from role persistence
    await UserRoleSkills.findOneAndUpdate(
      { userId, role: employee.role },
      { $pull: { skills: { name: skillName } } }
    );

    return employee;
  }

  async getRoleSkills(userId: string, role: string): Promise<IEmployeeSkill[]> {
    const roleSkills = await UserRoleSkills.findOne({ userId, role });
    return roleSkills?.skills || [];
  }

  private ensureCommsDir(project: any): void {
    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) return;
    const commsDir = path.join(cwd, '.agents', 'comms');
    if (!fs.existsSync(commsDir)) {
      fs.mkdirSync(commsDir, { recursive: true });
    }
  }
}
