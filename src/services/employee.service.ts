import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Employee, IEmployee, IEmployeeSkill, UserRoleSkills, ROLE_TEMPLATES, RoleTemplate } from '../models/employee.model';
import { EmployeeLog } from '../models/employee-log.model';
import { ManagerInbox } from '../models/manager-inbox.model';
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

WORKSPACE RULES:
This company folder is a MONOREPO workspace. Treat it as such.
- The root folder (${normCwd}) is the workspace root. It contains multiple projects/apps.
- When working on a new application, feature, or deliverable, ALWAYS create a dedicated project subfolder.
  - Name it descriptively: e.g., "landing-page/", "api-server/", "mobile-app/", "marketing-site/", "admin-dashboard/", etc.
  - Example: if your cwd is ${normCwd}, create ${normCwd}/landing-page/ and put all related code there.
  - Each project subfolder should have its own structure (src/, package.json, etc.) as appropriate for its tech stack.
- If a project subfolder already exists for the work you're doing, use it — do NOT create duplicates.
- Before starting, ALWAYS list the root directory to see what projects already exist.
- The root folder may contain shared config files (docker-compose.yml, .gitignore, README.md) — those are fine at the root level.
- The .agents/ folder is reserved for internal communication — never put project code in there.

TECH STACK (MANDATORY):
- Backend code MUST be written in Node.js (TypeScript preferred).
- Frontend code MUST be written in Next.js (React + TypeScript).
- Do NOT use other backend frameworks (Django, Flask, Rails, etc.) or frontend frameworks (Angular, Vue, Svelte, etc.) unless explicitly told otherwise for a specific project.
- When creating a new backend project subfolder, initialize it with Node.js (package.json, tsconfig.json, etc.).
- When creating a new frontend project subfolder, initialize it with Next.js (npx create-next-app or manual setup).
- If you find existing code in a different stack, do NOT rewrite it unless asked — but all NEW code must follow this rule.

DOCKER (MANDATORY):
- ALL applications MUST be containerized with Docker.
- Every project subfolder that contains a runnable app MUST have a Dockerfile.
- The workspace root MUST have a docker-compose.yml that orchestrates all services.
- If a docker-compose.yml already exists at the root, ADD your service to it — do NOT create a separate one.
- Use multi-stage builds for production images (build stage + slim runtime stage).
- Expose ports via docker-compose, not directly on the host.
- For local development, use docker-compose with volume mounts for hot-reload.
- Always include a .dockerignore in each project subfolder (exclude node_modules, .next, dist, etc.).
- When your task involves running or deploying an app, verify it works inside Docker — do NOT just test with bare "node" or "npm start".

FILE RULES:
- Always use forward slashes (/) in file paths, never backslashes.
- When creating new files, use the Write tool with the full absolute path.
- Before writing to a directory, make sure it exists (use Bash: mkdir -p path/to/dir).
- Keep the workspace root clean — only shared config and project folders at the top level.
- To create a NEW file without needing Read first, use: node scripts/write-file.js <filepath> <content>
- Or use Bash with echo/printf to write file content.

ENVIRONMENT (CRITICAL — READ THIS):
- OS: Windows 11 + Git Bash
- "python3" is NOT available — use "node -e" for one-liners instead
- For new files: prefer Edit tool or "node scripts/write-file.js <path> <content>"
- For existing files: use Read first, then Write or Edit
- NEVER use cat heredoc (cat << 'EOF') with content containing quotes — it breaks on Git Bash
- ALWAYS use forward slashes in paths, even on Windows
- Use "node" not "node.exe", "npm" not "npm.cmd"
- If a command fails with "permission denied" or "requires approval": DO NOT retry the same command. Switch to a different method immediately.

PRE-APPROVED COMMANDS (already allowed — no permission needed):
Your workspace has a .claude/settings.local.json that pre-approves these commands:
- node, npm, npx (any arguments) — use freely for running scripts, installing packages, building
- mkdir, ls, cat, wc, cp, mv, touch, find, grep, pwd, echo, cd, which, type — standard filesystem ops
- git (any arguments) — commits, branches, status, etc.
- docker, docker-compose — building images, running containers, managing services
- ngrok — exposing local services for testing and demos
- curl, wget — HTTP requests, downloading files
- tar, unzip — extracting archives
- python, pip — Python scripts and package management
- tsc, eslint, prettier — TypeScript compiler, linting, formatting
- rm (any arguments including rm -rf) — cleanup
- All tools (Read, Edit, Write, Glob, Grep) are pre-approved
You do NOT need to worry about permission popups for any of the above. Just run them.

FILE CREATION HELPER:
A helper script exists at scripts/write-file.js in the workspace root.
Usage: node scripts/write-file.js <filepath> "<content>"
This creates the file AND its parent directories — no Read required first.
Use this when you need to create a brand new file and the Write tool complains about not having Read it first.

ANTI-LOOP PROTECTION (MANDATORY):
If a tool call or command fails, returns an error, or is denied:
1. DO NOT retry the exact same command or tool call.
2. Try a DIFFERENT approach (different tool, different command syntax, or different method entirely).
3. After 3 failed attempts at the SAME goal, STOP trying that approach entirely.
4. Write a status report explaining what you tried and what failed to .agents/comms/${employee.role}-blocked.md
5. Write an inbox message to Alfred explaining the blocker.
6. Move on to other parts of your task that you CAN complete.
NEVER loop on the same failing action. This wastes time and resources. Adapt or escalate.

TEAM MEMBERS:
${teamList}

COMMUNICATION:
- Read messages from team: check files in ${commsDir}/
- Write your updates: create/update files in ${commsDir}/ named like "${employee.role}-update.md" or "${employee.role}-to-<role>.md"
- Always check .agents/comms/ for messages from other team members before starting work
- Write a brief status update in .agents/comms/${employee.role}-status.md when you finish

MESSAGES TO ALFRED (your manager):
If you need to communicate something to Alfred (your manager), write a JSON file to:
  ${normCwd}/.agents/inbox/alfred-${employee.role}-${taskId}.json
The file MUST be valid JSON with this structure:
{
  "type": "issue" | "question" | "confirmation" | "completion" | "info",
  "subject": "Short one-line summary",
  "body": "Detailed explanation of what you need, found, or want to report"
}
Use this when:
- You hit a blocker or error you can't resolve → type: "issue"
- You need input or a decision from the manager → type: "question"
- You finished something significant and want review → type: "confirmation"
- You completed the full task with a summary → type: "completion"
- You found something noteworthy (security issue, optimization, etc.) → type: "info"
You can write MULTIPLE inbox files (use different filenames) if you have several things to report.
Alfred reads these between loops and will act on them. Do NOT skip this — proactive communication is expected.

EXECUTION LOG (MANDATORY):
When you finish your task, you MUST write an execution log to: ${normCwd}/.agents/exec-logs/${employee.role}-${taskId}.md
The log must contain:
- Task: what you were asked to do
- Files Changed: list every file you created, modified, or deleted (with full paths)
- Actions Taken: brief summary of each step you performed
- Output: the result/outcome of your work
- Issues: any problems encountered or things left incomplete
- Status: ✅ Completed / ⚠️ Partial / ❌ Failed
This log is read by the Infra Administrator to verify your work. Be honest and thorough.

YOUR TASK:
${task}`;

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastSdkSessionId: string | undefined;
    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
    let lastError = '';

    const eventHandler = (event: any) => {
      if (event.type === 'tool_use') {
        empLog(userId, eId, pId, 'tool_use', `${event.tool}: ${(event.content || '').substring(0, 300)}`, empInfo, pName, { tool: event.tool });
      } else if (event.type === 'tool_result') {
        empLog(userId, eId, pId, 'tool_result', (event.content || '').substring(0, 500), empInfo, pName);
      } else if (event.type === 'text') {
        empLog(userId, eId, pId, 'text', (event.content || '').substring(0, 1000), empInfo, pName);
      } else if (event.type === 'error') {
        empLog(userId, eId, pId, 'error', event.content || 'Unknown error', empInfo, pName);
      }
      onEvent(event);
    };

    try {
      while (attempt < MAX_RETRIES) {
        attempt++;
        const isRetry = attempt > 1;

        if (isRetry) {
          empLog(userId, eId, pId, 'text', `🔄 Retry ${attempt}/${MAX_RETRIES} — resuming where left off...`, empInfo, pName, { attempt, taskId });
          onEvent({ type: 'text', content: `🔄 Retry ${attempt}/${MAX_RETRIES} — resuming...`, sessionId: '', timestamp: new Date() });

          // Update lastActivity so watchdog doesn't kill us
          await Employee.findByIdAndUpdate(employeeId, { lastActivity: new Date() });
        }

        const currentPrompt = isRetry && lastSdkSessionId
          ? `You were working on a task but got interrupted. Continue where you left off. The original task was:\n\n${task}\n\nPick up from where you stopped. Check your recent work and continue.`
          : prompt;

        const resumeId = isRetry ? lastSdkSessionId : undefined;

        try {
          const result = await claudeCodeService.runCommand(cwd, currentPrompt, eventHandler, {
            allowedTools: employee.allowedTools?.length ? employee.allowedTools : undefined,
            resumeSdkSessionId: resumeId,
          });

          if (result.sdkSessionId) lastSdkSessionId = result.sdkSessionId;

          if (result.status === 'completed') {
            finalStatus = 'completed';
            const textEvents = result.events.filter(e => e.type === 'text').map(e => e.content).join('\n');
            // Update task in DB
            const fresh = await Employee.findById(employeeId);
            if (fresh) {
              const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
              if (taskEntry) { taskEntry.status = 'completed'; taskEntry.completedAt = new Date(); taskEntry.result = textEvents.substring(0, 5000); }
              fresh.status = 'idle';
              fresh.currentTask = '';
              fresh.lastActivity = new Date();
              await fresh.save();
            }
            break; // Success — exit retry loop
          }

          if (result.status === 'cancelled') {
            finalStatus = 'cancelled';
            const fresh = await Employee.findById(employeeId);
            if (fresh) {
              const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
              if (taskEntry) { taskEntry.status = 'failed'; taskEntry.completedAt = new Date(); taskEntry.result = 'Cancelled'; }
              fresh.status = 'idle';
              fresh.currentTask = '';
              await fresh.save();
            }
            break; // Cancelled — don't retry
          }

          // Failed — will retry if attempts remain
          lastError = result.status;
          empLog(userId, eId, pId, 'error', `Attempt ${attempt} failed (${result.status})${attempt < MAX_RETRIES ? ' — will retry' : ''}`, empInfo, pName, { attempt, taskId });

        } catch (err: any) {
          lastError = err.message;
          empLog(userId, eId, pId, 'error', `Attempt ${attempt} crashed: ${err.message}${attempt < MAX_RETRIES ? ' — will retry' : ''}`, empInfo, pName, { attempt, taskId });

          if (attempt >= MAX_RETRIES) throw err;
        }

        // Brief pause before retry
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // All retries exhausted without success
      if (finalStatus !== 'completed' && finalStatus !== 'cancelled') {
        const fresh = await Employee.findById(employeeId);
        if (fresh) {
          const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
          if (taskEntry) { taskEntry.status = 'failed'; taskEntry.completedAt = new Date(); taskEntry.result = `Failed after ${attempt} attempts: ${lastError}`; }
          fresh.status = 'idle';
          fresh.currentTask = '';
          await fresh.save();
        }
      }

      const duration = Date.now() - startTime;
      telemetryService.track({
        userId, projectId: pId, employeeId: eId,
        type: 'employee_task', source: `employee:${employee.role}`,
        status: finalStatus === 'completed' ? 'completed' : 'failed',
        description: task, durationMs: duration,
        error: finalStatus !== 'completed' ? lastError : undefined,
      });

      this.collectInboxMessages(userId, eId, pId, cwd, empInfo, pName, taskId).catch(() => {});

      if (finalStatus === 'completed') {
        empLog(userId, eId, pId, 'task_complete', `Task completed in ${((duration) / 1000).toFixed(1)}s (${attempt} attempt${attempt > 1 ? 's' : ''}): ${task}`, empInfo, pName, { durationMs: duration, taskId, attempts: attempt });
        telegramService.notifyTaskCompleted(employee.name, project.name, task).catch(() => {});
      } else {
        empLog(userId, eId, pId, 'task_fail', `Task failed after ${attempt} attempt(s): ${task}`, empInfo, pName, { durationMs: duration, taskId, attempts: attempt, lastError });
        telegramService.notifyTaskFailed(employee.name, project.name, task, `Failed after ${attempt} attempts: ${lastError}`).catch(() => {});
      }

      return { status: finalStatus };
    } catch (error: any) {
      const fresh = await Employee.findById(employeeId);
      if (fresh) {
        const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
        if (taskEntry) { taskEntry.status = 'failed'; taskEntry.result = error.message; taskEntry.completedAt = new Date(); }
        fresh.status = 'idle';
        fresh.currentTask = '';
        await fresh.save();
      }

      this.collectInboxMessages(userId, eId, pId, cwd, empInfo, pName, taskId).catch(() => {});

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

  /** Stop a running employee task */
  async stopTask(userId: string, employeeId: string): Promise<{ stopped: boolean }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');
    if (employee.status !== 'working') return { stopped: false };

    // Cancel the Claude Code session
    if (employee.currentTask) {
      claudeCodeService.cancelSession(employee.currentTask);
    }

    const lastTask = employee.taskHistory[employee.taskHistory.length - 1];
    if (lastTask?.status === 'in_progress') {
      lastTask.status = 'failed';
      lastTask.result = 'Stopped by user';
      lastTask.completedAt = new Date();
    }
    employee.status = 'idle';
    employee.currentTask = '';
    await employee.save();

    const project = await projectService.findById(employee.projectId.toString(), userId);
    empLog(userId, employeeId, employee.projectId.toString(), 'task_fail',
      `⏹️ Task stopped by user`, { name: employee.name, avatar: employee.avatar, role: employee.role },
      project?.name || 'Unknown');

    return { stopped: true };
  }

  /**
   * Send a message to an employee mid-execution.
   * If the employee is working, injects the message into the running Claude Code session.
   * The agent receives it as a new instruction and adapts on the fly.
   */
  async sendMessage(userId: string, employeeId: string, message: string): Promise<{ delivered: boolean; detail: string }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    if (employee.status !== 'working' || !employee.currentTask) {
      return { delivered: false, detail: `${employee.name} is not currently working. Status: ${employee.status}` };
    }

    const project = await projectService.findById(employee.projectId.toString(), userId);
    const pName = project?.name || 'Unknown';
    const empInfo = { name: employee.name, avatar: employee.avatar, role: employee.role };

    // Inject into the running Claude Code session
    const injected = claudeCodeService.injectMessage(employee.currentTask, message);

    if (injected) {
      empLog(userId, employee._id.toString(), employee.projectId.toString(), 'text',
        `📩 Gordon message injected: ${message}`, empInfo, pName, { injected: true });
      return { delivered: true, detail: `Message delivered to ${employee.name} mid-execution` };
    }

    // Fallback: write to comms file so the agent sees it when it next checks
    if (project) {
      const allFolders = [...(project.folders || [])];
      if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
      const cwd = allFolders[0];
      if (cwd) {
        const commsDir = path.join(cwd, '.agents', 'comms');
        if (!fs.existsSync(commsDir)) fs.mkdirSync(commsDir, { recursive: true });
        const urgentFile = path.join(commsDir, `URGENT-gordon-${Date.now()}.md`);
        fs.writeFileSync(urgentFile, `# Urgent Message from Gordon\n\n**Time**: ${new Date().toISOString()}\n**To**: ${employee.name}\n\n${message}\n`, 'utf-8');
        empLog(userId, employee._id.toString(), employee.projectId.toString(), 'comms',
          `📩 Gordon urgent message written to comms (session not found for direct injection): ${message}`, empInfo, pName);
        return { delivered: true, detail: `Message written to comms for ${employee.name} (will be picked up when agent checks comms)` };
      }
    }

    return { delivered: false, detail: `Could not deliver message to ${employee.name} — no active session and no comms folder` };
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

  /**
   * Collect inbox messages written by an employee after task execution.
   * Scans .agents/inbox/ for JSON files matching this employee/task,
   * parses them, saves to ManagerInbox, and deletes the files.
   */
  async collectInboxMessages(
    userId: string, employeeId: string, projectId: string,
    cwd: string, empInfo: { name: string; avatar: string; role: string },
    projectName: string, taskId: string,
  ): Promise<number> {
    const inboxDir = path.join(cwd, '.agents', 'inbox');
    if (!fs.existsSync(inboxDir)) return 0;

    let collected = 0;
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(inboxDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const msg = JSON.parse(raw);

        const validTypes = ['issue', 'question', 'confirmation', 'completion', 'info'];
        const type = validTypes.includes(msg.type) ? msg.type : 'info';

        await ManagerInbox.create({
          userId,
          employeeId,
          projectId,
          employeeName: empInfo.name,
          employeeAvatar: empInfo.avatar,
          employeeRole: empInfo.role,
          projectName,
          type,
          subject: (msg.subject || 'No subject').substring(0, 300),
          body: (msg.body || '').substring(0, 5000),
          read: false,
        });

        // Delete the file after processing
        fs.unlinkSync(filePath);
        collected++;

        empLog(userId, employeeId, projectId, 'comms',
          `📨 Sent to Alfred [${type}]: ${(msg.subject || '').substring(0, 100)}`,
          empInfo, projectName, { inboxType: type, taskId });
      } catch (err: any) {
        // Bad JSON or write error — log but don't crash
        empLog(userId, employeeId, projectId, 'error',
          `Failed to parse inbox file ${file}: ${err.message}`,
          empInfo, projectName);
      }
    }

    return collected;
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
    const execLogsDir = path.join(cwd, '.agents', 'exec-logs');
    if (!fs.existsSync(execLogsDir)) {
      fs.mkdirSync(execLogsDir, { recursive: true });
    }
    const inboxDir = path.join(cwd, '.agents', 'inbox');
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    // Level 1-2: Auto-provision .claude/settings.local.json with permission allowlist
    this.ensureClaudeSettings(cwd);

    // Level 3: Auto-provision scripts/write-file.js helper
    this.ensureWriteFileHelper(cwd);
  }

  /** Level 1-2: Create/update .claude/settings.local.json in the project cwd so agents can run without permission blocks */
  private ensureClaudeSettings(cwd: string): void {
    const claudeDir = path.join(cwd, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const settings = {
      permissions: {
        allow: [
          "Bash(node *)",
          "Bash(npm *)",
          "Bash(npx *)",
          "Bash(mkdir *)",
          "Bash(ls *)",
          "Bash(cat *)",
          "Bash(wc *)",
          "Bash(rm *.js)",
          "Bash(rm *.tmp)",
          "Bash(rm -rf node_modules)",
          "Bash(rm -rf *)",
          "Bash(git *)",
          "Bash(docker *)",
          "Bash(docker-compose *)",
          "Bash(ngrok *)",
          "Bash(cp *)",
          "Bash(mv *)",
          "Bash(touch *)",
          "Bash(find *)",
          "Bash(grep *)",
          "Bash(pwd)",
          "Bash(echo *)",
          "Bash(cd *)",
          "Bash(which *)",
          "Bash(type *)",
          "Bash(tsc *)",
          "Bash(eslint *)",
          "Bash(prettier *)",
          "Bash(curl *)",
          "Bash(wget *)",
          "Bash(tar *)",
          "Bash(unzip *)",
          "Bash(python *)",
          "Bash(pip *)",
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep"
        ]
      }
    };

    // Always overwrite to ensure latest permissions are applied
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  }

  /** Level 3: Create scripts/write-file.js helper so agents can create files without Read-first requirement */
  private ensureWriteFileHelper(cwd: string): void {
    const scriptsDir = path.join(cwd, 'scripts');
    const helperFile = path.join(scriptsDir, 'write-file.js');
    if (fs.existsSync(helperFile)) return;

    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }

    const script = `// Auto-generated helper for Claude Code agents
// Usage: node scripts/write-file.js <filepath> <content>
// Or pipe content: echo "content" | node scripts/write-file.js <filepath>
const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node scripts/write-file.js <filepath> [content]'); process.exit(1); }

const absPath = path.resolve(filePath);

// Content from args or stdin
let content = process.argv.slice(3).join(' ');
if (!content && !process.stdin.isTTY) {
  content = require('fs').readFileSync('/dev/stdin', 'utf8');
}

fs.mkdirSync(path.dirname(absPath), { recursive: true });
fs.writeFileSync(absPath, content, 'utf8');
console.log('Written: ' + absPath + ' (' + content.length + ' bytes)');
`;

    fs.writeFileSync(helperFile, script, 'utf-8');
  }
}
