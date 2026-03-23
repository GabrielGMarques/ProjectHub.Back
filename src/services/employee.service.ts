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
import { employeeMemoryService } from './employee-memory.service';
import { wsService } from './websocket.service';
import { TokenUsageService } from './token-usage.service';

const claudeCodeService = new ClaudeCodeService();
const telegramService = telegramBot;
const tokenUsageService = new TokenUsageService();

/**
 * Reference Claude configuration — based on the Influencer project's known-good config.
 * Every employee session must have these exact permissions before execution.
 */
const REFERENCE_SETTINGS_LOCAL = {
  permissions: {
    allow: [
      "Bash(node *)",
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(git *)",
      "Bash(docker *)",
      "Bash(docker-compose *)",
      "Bash(python *)",
      "Bash(pip *)",
      "Bash(mkdir *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(rm *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(touch *)",
      "Bash(find *)",
      "Bash(grep *)",
      "Bash(echo *)",
      "Bash(cd *)",
      "Bash(pwd)",
      "Bash(which *)",
      "Bash(type *)",
      "Bash(tsc *)",
      "Bash(eslint *)",
      "Bash(prettier *)",
      "Bash(tar *)",
      "Bash(unzip *)",
      "Bash(ngrok *)",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "WebSearch",
      "mcp__playwright_*",
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_screenshot",
      "mcp__playwright__browser_console_messages",
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_close",
      "mcp__playwright__browser_drag",
      "mcp__playwright__browser_file_upload",
      "mcp__playwright__browser_handle_dialog",
      "mcp__playwright__browser_hover",
      "mcp__playwright__browser_install",
      "mcp__playwright__browser_keyboard_type",
      "mcp__playwright__browser_network_requests",
      "mcp__playwright__browser_pdf_save",
      "mcp__playwright__browser_press_key",
      "mcp__playwright__browser_resize",
      "mcp__playwright__browser_select_option",
      "mcp__playwright__browser_tab_close",
      "mcp__playwright__browser_tab_list",
      "mcp__playwright__browser_tab_new",
      "mcp__playwright__browser_type",
      "mcp__playwright__browser_wait"
    ]
  }
};

const REFERENCE_GLOBAL_TOOLS = [
  'Bash', 'Bash(*)',
  'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(curl *)', 'Bash(wget *)',
  'Bash(git *)', 'Bash(docker *)', 'Bash(docker-compose *)',
  'Bash(python *)', 'Bash(pip *)', 'Bash(mkdir *)', 'Bash(ls *)', 'Bash(cat *)',
  'Bash(rm *)', 'Bash(cp *)', 'Bash(mv *)', 'Bash(touch *)', 'Bash(find *)',
  'Bash(grep *)', 'Bash(echo *)', 'Bash(cd *)', 'Bash(pwd)',
  'Bash(tsc *)', 'Bash(tar *)', 'Bash(unzip *)', 'Bash(ngrok *)',
  'Bash(which *)', 'Bash(type *)',
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__playwright_*',
  'mcp__playwright__browser_navigate', 'mcp__playwright__browser_click',
  'mcp__playwright__browser_fill_form', 'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_screenshot', 'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_evaluate', 'mcp__playwright__browser_close',
  'mcp__playwright__browser_drag', 'mcp__playwright__browser_file_upload',
  'mcp__playwright__browser_handle_dialog', 'mcp__playwright__browser_hover',
  'mcp__playwright__browser_install', 'mcp__playwright__browser_keyboard_type',
  'mcp__playwright__browser_network_requests', 'mcp__playwright__browser_pdf_save',
  'mcp__playwright__browser_press_key', 'mcp__playwright__browser_resize',
  'mcp__playwright__browser_select_option', 'mcp__playwright__browser_tab_close',
  'mcp__playwright__browser_tab_list', 'mcp__playwright__browser_tab_new',
  'mcp__playwright__browser_type', 'mcp__playwright__browser_wait',
];
/**
 * Full SDK-level tool set — passed to every query() call regardless of role.
 * Role-specific behavior is enforced by the system prompt, not tool restrictions.
 * Restricting SDK tools causes employees to silently fail when they need Bash/Edit/Write.
 */
const SDK_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebSearch', 'Agent',
  'mcp__playwright_*',
  'mcp__playwright__browser_navigate', 'mcp__playwright__browser_click',
  'mcp__playwright__browser_fill_form', 'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_screenshot', 'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_evaluate', 'mcp__playwright__browser_close',
  'mcp__playwright__browser_drag', 'mcp__playwright__browser_file_upload',
  'mcp__playwright__browser_handle_dialog', 'mcp__playwright__browser_hover',
  'mcp__playwright__browser_install', 'mcp__playwright__browser_keyboard_type',
  'mcp__playwright__browser_network_requests', 'mcp__playwright__browser_pdf_save',
  'mcp__playwright__browser_press_key', 'mcp__playwright__browser_resize',
  'mcp__playwright__browser_select_option', 'mcp__playwright__browser_tab_close',
  'mcp__playwright__browser_tab_list', 'mcp__playwright__browser_tab_new',
  'mcp__playwright__browser_type', 'mcp__playwright__browser_wait',
];

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
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  EmployeeLog.create({
    userId, employeeId, projectId, category,
    content: `[${timestamp}] ${content}`,
    employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role,
    projectName, metadata,
  }).catch(() => {});

  // Real-time push
  wsService.employeeLog(employeeId, projectId, { category, content, employeeName: emp.name });
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

  /**
   * Debug: return the .claude configuration that would be loaded for this employee's session.
   * Reads both .claude/settings.local.json and ~/.claude.json trust entry, compares to reference,
   * and reports match status + differences.
   */
  async getDebugConfig(userId: string, employeeId: string): Promise<{
    employee: { name: string; role: string; status: string; roleTools: string[]; sdkTools: string[] };
    projectPath: string;
    settingsLocal: { exists: boolean; content: any; matchesReference: boolean; missing: string[]; extra: string[] };
    globalTrust: { exists: boolean; hasTrust: boolean; allowedTools: string[]; matchesReference: boolean; missingTools: string[] };
    reference: { settingsLocal: any; globalTools: string[] };
    validation: { valid: boolean; issues: string[]; fixed: boolean };
    sessionInfo: { sdkSessionId: string; activeSessionId: string; isAlive: boolean };
  }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    const project = await projectService.findById(employee.projectId.toString(), userId);
    if (!project) throw new Error('Project not found');

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0] || '';

    // Read settings.local.json
    const claudeDir = path.join(cwd, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');
    let settingsLocal: any = { exists: false, content: null, matchesReference: false, missing: [], extra: [] };

    try {
      if (cwd && fs.existsSync(settingsFile)) {
        const content = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        const refAllow = REFERENCE_SETTINGS_LOCAL.permissions.allow;
        const curAllow: string[] = content?.permissions?.allow || [];
        const missing = refAllow.filter((t: string) => !curAllow.includes(t));
        const extra = curAllow.filter((t: string) => !refAllow.includes(t));
        settingsLocal = {
          exists: true,
          content,
          matchesReference: missing.length === 0,
          missing,
          extra,
        };
      }
    } catch (err: any) {
      settingsLocal = { exists: false, content: null, matchesReference: false, missing: [], extra: [], error: err.message };
    }

    // Read ~/.claude.json trust entry
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const normalizedCwd = cwd.replace(/\\/g, '/');
    let globalTrust: any = { exists: false, hasTrust: false, allowedTools: [], matchesReference: false, missingTools: [] };

    try {
      if (fs.existsSync(claudeJsonPath)) {
        const config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        const entry = config.projects?.[normalizedCwd] || config.projects?.[cwd];
        if (entry) {
          const missingTools = REFERENCE_GLOBAL_TOOLS.filter((t: string) => !entry.allowedTools?.includes(t));
          globalTrust = {
            exists: true,
            hasTrust: entry.hasTrustDialogAccepted === true,
            allowedTools: entry.allowedTools || [],
            matchesReference: missingTools.length === 0 && entry.hasTrustDialogAccepted === true,
            missingTools,
          };
        }
      }
    } catch (err: any) {
      globalTrust = { exists: false, hasTrust: false, allowedTools: [], matchesReference: false, missingTools: [], error: err.message };
    }

    // Run validation (also auto-fixes)
    let validation = { valid: true, issues: [] as string[], fixed: false };
    if (cwd) {
      validation = this.validateClaudeConfig(cwd);
    } else {
      validation = { valid: false, issues: ['No project path configured'], fixed: false };
    }

    // Session info
    const isAlive = claudeCodeService.isSessionAlive(employee.activeSessionId || '');

    return {
      employee: {
        name: employee.name,
        role: employee.role,
        status: employee.status,
        roleTools: employee.allowedTools,
        sdkTools: SDK_ALLOWED_TOOLS,
      },
      projectPath: normalizedCwd,
      settingsLocal,
      globalTrust,
      reference: {
        settingsLocal: REFERENCE_SETTINGS_LOCAL,
        globalTools: REFERENCE_GLOBAL_TOOLS,
      },
      validation,
      sessionInfo: {
        sdkSessionId: employee.sdkSessionId || '',
        activeSessionId: employee.activeSessionId || '',
        isAlive,
      },
    };
  }

  async assignTask(
    userId: string,
    employeeId: string,
    task: string,
    onEvent: (event: any) => void
  ): Promise<{ status: string }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    // Try to inject into existing session — only if employee is WORKING (mid-task injection).
    // Idle employees get a fresh session so they pick up the latest SDK_ALLOWED_TOOLS.
    const existingSession = employee.activeSessionId || employee.currentTask;
    if (existingSession && employee.status === 'working') {
      const msg = `ADDITIONAL TASK FROM ALFRED (add to your current work):\n${task}\n\nHandle this alongside or after your current task.`;
      const injected = claudeCodeService.injectMessage(existingSession, msg);
      if (injected) {
        const taskId = crypto.randomUUID();
        employee.status = 'working';
        employee.currentTask = existingSession;
        employee.lastActivity = new Date();
        employee.lastAssignedAt = new Date();
        employee.taskHistory.push({ taskId, description: task, status: 'in_progress', resultRead: false, startedAt: new Date() });
        await employee.save();

        const project = await projectService.findById(employee.projectId.toString(), userId);
        const empInfo = { name: employee.name, avatar: employee.avatar, role: employee.role };
        empLog(userId, employee._id.toString(), employee.projectId.toString(), 'task_start',
          `[Injected into session] ${task}`, empInfo, project?.name || 'Unknown', { taskId, resumed: true });
        telegramService.notifyTaskStarted(employee.name, project?.name || 'Unknown', task).catch(() => {});
        return { status: 'resumed' };
      }
      // Inject failed — session is dead, clear and fall through to new session
      employee.activeSessionId = '';
      await employee.save();
    }

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
    employee.lastAssignedAt = new Date();
    employee.taskHistory.push({
      taskId,
      description: task,
      status: 'in_progress',
      resultRead: false,
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

    // Build skills context — employee's assigned skills + discovered local Claude Code skills
    const skillsCtx = this.buildSkillsContext(employee, cwd);
    const memoryCtx = await employeeMemoryService.buildMemoryContext(employee._id.toString());

    // Build applications context
    const appsCtx = (project.applications || []).length > 0
      ? `\nREGISTERED APPLICATIONS:\n${(project.applications || []).map(a =>
          `  - ${a.name} (${a.type}:${a.port}) — ${a.status} — path: ${a.basePath || '/' + project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '/' + a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')} — docker: ${a.dockerService || 'N/A'}`
        ).join('\n')}\n  Gateway URL: https://nonshattering-adelaida-ponchoed.ngrok-free.dev`
      : '';

    // Include company direction if set
    const directionCtx = project.strategicDirection
      ? `\nCOMPANY STRATEGIC DIRECTION (set by leadership — align your work with this):\n${project.strategicDirection.substring(0, 3000)}\n`
      : '';

    const prompt = `${employee.systemPrompt}

PROJECT: ${project.name}
${project.description ? `DESCRIPTION: ${project.description}` : ''}
WORKING DIRECTORY: ${normCwd}
${normFolders.length > 1 ? `ALL PROJECT FOLDERS:\n${normFolders.map(f => `  - ${f}`).join('\n')}` : ''}${appsCtx}${directionCtx}

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

PREFERRED TECH STACK:
- Backend: Node.js (TypeScript preferred) with Express or Fastify — this is the default choice for new backends.
- Frontend: Next.js (React + TypeScript) — this is the default choice for new frontends.
- These are PREFERENCES, not hard rules. If the task requires a different technology (Python, Go, PHP, etc.) or you're integrating a third-party service that uses a different stack, use whatever fits best.
- If you find existing code in a different stack, work with it — do NOT rewrite it unless asked.
- The only hard rule: the final result MUST run in a Docker container and be registered as a company application.

SUB-AGENTS (Agent tool):
- You can spawn sub-agents to parallelize work using the Agent tool.
- Use sub-agents for: independent research, searching large codebases, running tests while you continue coding, exploring multiple approaches simultaneously.
- Each sub-agent runs in its own context and returns results to you.
- Launch multiple agents in a single message to maximize parallelism.
- Keep sub-agent prompts focused and self-contained — they don't share your context.

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

COMMUNICATION PRIORITY ORDER:
Your #1 job after ANY progress is to UPDATE YOUR WORKING STATUS. Everything else is secondary.

1. UPDATE WORKING STATUS (after every significant action — this is how Alfred knows what's happening)
2. Check ${commsDir}/ for messages from teammates before starting work
3. If you need help from another role: write ${commsDir}/${employee.role}-to-<target-role>.md
4. If STUCK or need a DECISION: write an inbox message to ${normCwd}/.agents/inbox/alfred-${employee.role}-${taskId}.json
   Format: {"type":"issue"|"question","subject":"...","body":"..."}
   Only write inbox for issues/questions — Alfred reads your working status for everything else.

WORKING STATUS — YOUR #1 RESPONSIBILITY:
Alfred reads your working status to know what you're doing. He checks every 5 minutes.
This is your main communication channel with Alfred — he reads it BEFORE asking you anything.
${employee.workingStatus ? `\nYOUR CURRENT WORKING STATUS: "${employee.workingStatus}"` : '\nYou have NO working status set yet. UPDATE IT IMMEDIATELY.'}

HOW TO UPDATE (2-step process to avoid permission issues):
  Step 1: Write your status JSON to a temp file using the Write tool:
    File: ${normCwd}/.agents/status/${employee.role}.json
    Content: {"status":"YOUR MARKDOWN STATUS HERE"}

  Step 2: Send it with curl:
    curl -s -X POST http://localhost:3777/api/employees/${employee._id}/self/working-status -H "Content-Type: application/json" -d @${normCwd}/.agents/status/${employee.role}.json

  READ YOUR CURRENT STATUS AND TASKS:
    curl -s http://localhost:3777/api/employees/${employee._id}

  READ YOUR WORKING STATUS HISTORY (to remember what you did before):
    curl -s http://localhost:3777/api/employees/${employee._id}/self/status-history?limit=5
    This returns your previous status updates. Use it when you're restarted or unsure what you were doing.

  COMPANY DIRECTION & TEAM:
    curl -s http://localhost:3777/api/employees/${employee._id}/self/direction
    Returns the company's strategic direction + direction history. Align your work with this.
    curl -s http://localhost:3777/api/employees/${employee._id}/self/team
    Lists all employees in your company and their current status.

  SIMPLEST FALLBACK (if curl still fails — just write the .md file):
    Write your status directly to: ${normCwd}/.agents/status/${employee.role}.md
    The system watches this file and picks up changes automatically.

WHEN TO UPDATE:
1. IMMEDIATELY when you start working — what you plan to do
2. After EVERY significant action — file created, bug found, test passed, etc.
3. When DONE — include the word "done" or "idle" and the system auto-completes your tasks
4. When STUCK — describe the blocker so Alfred can help

YOUR STATUS MUST BE IN MARKDOWN FORMAT. Use headers, bullet lists, checkboxes, code blocks, and tables.

REQUIRED SECTIONS (use ## headers):
## Task — What Alfred asked you to do
## Progress — Checklist: ✅ done items, ⬜ pending items
## Files Changed — Table or list of every file created/modified/deleted
## Running Services — Ports, URLs, endpoints
## Current — What you are doing RIGHT NOW
## Blockers — Issues, errors (or "None")
## Next — What you will do next
## State — "working", "stuck", "done and idle"

EXAMPLE OF A GOOD STATUS:
"## Login Page Implementation

### Progress
- ✅ Created \`src/pages/Login.tsx\` — email/password form (89 lines)
- ✅ Added \`/login\` route in \`App.tsx\`
- ✅ Connected to auth API on port 4001
- ⬜ Forgot-password link
- ⬜ Error message styling

### Files Changed
| File | Action | Details |
|------|--------|---------|
| \`src/pages/Login.tsx\` | Created | 89 lines, form component |
| \`src/App.tsx\` | Modified | Added route |
| \`src/styles/login.css\` | Created | Styling |

### Running Services
- Frontend: \`http://localhost:3001\`
- Auth API: \`http://localhost:4001\`

### Current
Styling the error message component.

### Next
Add forgot-password flow, then mark done.

### State
working — ~70% complete"

BAD STATUS (DO NOT write like this): "Working on it." / "Almost done." / "Making progress."

CONSEQUENCES:
- No status update for 5 min → Alfred nudges you
- Still no update → Alfred warns you (and notifies Bruce)
- 3rd time → Alfred restarts your session

TASK COMPLETION (2-step — write JSON file then curl it):
  Step 1: Write tool → ${normCwd}/.agents/task-results/${employee.role}-${taskId}.json
    Content: {"taskId":"${taskId}","result":"DETAILED: what you built, files changed, ports"}

  Step 2: curl -s -X POST http://localhost:3777/api/employees/${employee._id}/self/task-done -H "Content-Type: application/json" -d @${normCwd}/.agents/task-results/${employee.role}-${taskId}.json

  TO SET IDLE:
    curl -s -X POST http://localhost:3777/api/employees/${employee._id}/self/status -H "Content-Type: application/json" -d '{"status":"idle"}'

  SIMPLEST FALLBACK:
    Write result to: ${normCwd}/.agents/task-results/${employee.role}-${taskId}.md
    Write "STATE: done and idle" in: ${normCwd}/.agents/status/${employee.role}.md

${skillsCtx}
${memoryCtx}
YOUR TASK:
${task}`;

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastSdkSessionId: string | undefined;
    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
    let lastError = '';

    const eventHandler = (event: any) => {
      // Capture session ID on start so we can resume later
      if (event.type === 'start' && event.sessionId) {
        Employee.findByIdAndUpdate(employeeId, { activeSessionId: event.sessionId }).catch(() => {});
      }
      // Task completed in keepAlive mode — mark employee idle without killing session
      // task_idle: SDK conversation ended — keep session reference but do NOT set employee idle.
      // The employee is responsible for calling task-done and setting themselves idle.
      if (event.type === 'task_idle') {
        Employee.findById(employeeId).then(fresh => {
          if (!fresh) return;
          fresh.lastActivity = new Date();
          if (event.sessionId) fresh.activeSessionId = event.sessionId;
          fresh.save().catch(() => {});
          // Collect inbox messages
          this.collectInboxMessages(userId, eId, pId, cwd, empInfo, pName, taskId).catch(() => {});
        }).catch(() => {});
      }
      if (event.type === 'tool_use') {
        empLog(userId, eId, pId, 'tool_use', `${event.tool}: ${(event.content || '').substring(0, 300)}`, empInfo, pName, { tool: event.tool });
      } else if (event.type === 'tool_result') {
        const resultText = event.content || '';
        empLog(userId, eId, pId, 'tool_result', resultText.substring(0, 500), empInfo, pName);
        // Auto-detect permission blocks — validate & fix config, then notify
        if (resultText.includes('requires approval') || resultText.includes('contains multiple operations')) {
          const check = this.validateClaudeConfig(cwd);
          const fixStatus = check.fixed ? 'config was mismatched and has been fixed' : 'config was already correct (SDK needs restart)';
          empLog(userId, eId, pId, 'error', `⚠️ Permission block detected — ${fixStatus}. Issues: ${check.issues.join('; ') || 'none'}`, empInfo, pName);
          telegramBot.send(`⚠️ *${employee.name}* is blocked by permissions on _${pName}_. Config ${check.fixed ? 'fixed' : 'OK'} — restart employee to apply: tell Alfred "restart ${employee.name}"`).catch(() => {});
        }
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

        // Validate .claude config matches reference before every execution attempt
        const configCheck = this.validateClaudeConfig(cwd);
        if (!configCheck.valid) {
          const fixMsg = configCheck.fixed ? ' (auto-fixed)' : '';
          empLog(userId, eId, pId, 'text',
            `🔧 Claude config mismatch detected${fixMsg}: ${configCheck.issues.join('; ')}`,
            empInfo, pName, { taskId, configIssues: configCheck.issues });
        }

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
            allowedTools: SDK_ALLOWED_TOOLS,
            resumeSdkSessionId: resumeId || employee.sdkSessionId || undefined,
            keepAlive: true,
            mcpServers: {
              playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
            },
          });

          if (result.sdkSessionId) lastSdkSessionId = result.sdkSessionId;

          // Record token usage
          if (result.tokenUsage) {
            tokenUsageService.record({
              userId, employeeId: eId, projectId: pId,
              source: 'employee',
              aiModel: result.tokenUsage.model,
              inputTokens: result.tokenUsage.inputTokens,
              outputTokens: result.tokenUsage.outputTokens,
              cacheReadTokens: result.tokenUsage.cacheReadTokens,
              cacheCreationTokens: result.tokenUsage.cacheCreationTokens,
              costUsd: result.tokenUsage.costUsd,
              durationMs: result.tokenUsage.durationMs,
              numTurns: result.tokenUsage.numTurns,
              metadata: { taskId, employeeName: employee.name, employeeRole: employee.role },
            });
          }

          if (result.status === 'completed') {
            finalStatus = 'completed';
            // Session ended — save session ID for resume, but do NOT set idle.
            // Employee is responsible for calling task-done + setting idle.
            const fresh = await Employee.findById(employeeId);
            if (fresh) {
              fresh.lastActivity = new Date();
              if (result.sdkSessionId) fresh.sdkSessionId = result.sdkSessionId;
              await fresh.save();
            }
            break; // Exit retry loop — employee handles the rest
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

      // All retries exhausted — log failure but do NOT set idle. Employee handles it.
      if (finalStatus !== 'completed' && finalStatus !== 'cancelled') {
        const fresh = await Employee.findById(employeeId);
        if (fresh) {
          const taskEntry = fresh.taskHistory.find(t => t.taskId === taskId);
          if (taskEntry) { taskEntry.status = 'failed'; taskEntry.completedAt = new Date(); taskEntry.result = `Failed after ${attempt} attempts: ${lastError}`; }
          fresh.lastActivity = new Date();
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

      // Log the session end — but employee controls task-done and idle via self-management API
      if (finalStatus !== 'completed' && finalStatus !== 'cancelled') {
        empLog(userId, eId, pId, 'error', `Session ended after ${attempt} attempt(s): ${lastError}`, empInfo, pName, { durationMs: duration, taskId, attempts: attempt, lastError });
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
  /** Stop = kill session completely. Only when Bruce explicitly asks. */
  async stopTask(userId: string, employeeId: string): Promise<{ stopped: boolean }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    // Kill all sessions
    if (employee.currentTask) claudeCodeService.cancelSession(employee.currentTask);
    if (employee.activeSessionId && employee.activeSessionId !== employee.currentTask) {
      claudeCodeService.cancelSession(employee.activeSessionId);
    }

    const lastTask = employee.taskHistory[employee.taskHistory.length - 1];
    if (lastTask?.status === 'in_progress') {
      lastTask.status = 'failed';
      lastTask.result = 'Stopped by Bruce';
      lastTask.completedAt = new Date();
    }
    employee.status = 'idle';
    employee.currentTask = '';
    employee.activeSessionId = '';
    employee.sdkSessionId = '';
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

    // Try to deliver to active session — works for both working and idle employees
    const sessionToUse = employee.currentTask || employee.activeSessionId;
    if (!sessionToUse) {
      return { delivered: false, detail: `${employee.name} has no active session. Assign a task first to wake them up.` };
    }

    const project = await projectService.findById(employee.projectId.toString(), userId);
    const pName = project?.name || 'Unknown';
    const empInfo = { name: employee.name, avatar: employee.avatar, role: employee.role };

    // Inject into the running Claude Code session
    const injected = claudeCodeService.injectMessage(sessionToUse, message);

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

  /**
   * Restart an employee. Two modes:
   * - force=false (default, used by Alfred): if session alive, just nudge; if dead, self-eval
   * - force=true (used by Bruce/HR panel): always kill session and boot fresh
   */
  async restartEmployee(userId: string, employeeId: string, force = false): Promise<{ message: string }> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    const sessionId = employee.activeSessionId || employee.currentTask;
    const sessionAlive = sessionId ? claudeCodeService.isSessionAlive(sessionId) : false;

    // Soft mode (Alfred): if session alive, just nudge
    if (!force && sessionAlive) {
      claudeCodeService.injectMessage(sessionId!,
        `[CHECK-IN from Alfred] Please update your working status NOW.\n` +
        `If you're done: write "State: done and idle" in your status.\n` +
        `If still working: update progress so Alfred knows what's happening.\n` +
        `Fetch your status history if needed: curl -s http://localhost:3777/api/employees/${employeeId}/self/status-history?limit=5`
      );
      employee.lastActivity = new Date();
      await employee.save();
      return { message: `${employee.name} is still active — nudged to update status.` };
    }

    // Session is dead — safe to restart with self-evaluation
    // Collect context BEFORE clearing
    const recentTasks = employee.taskHistory.slice(-5).map(t =>
      `- [${t.status}] "${t.description.substring(0, 120)}"${t.result ? ` → ${t.result.substring(0, 150)}` : ''}`
    ).join('\n');
    const lastWS = employee.workingStatus || '';

    // Preserve in-progress tasks — do NOT mark them as failed.
    // The self-eval will check if they're actually done.
    const pendingTasks = employee.taskHistory
      .filter(t => t.status === 'in_progress')
      .map(t => `- "${t.description.substring(0, 120)}"`)
      .join('\n');

    // Clear session refs but keep task history intact
    if (employee.currentTask) claudeCodeService.cancelSession(employee.currentTask);
    if (employee.activeSessionId && employee.activeSessionId !== employee.currentTask) {
      claudeCodeService.cancelSession(employee.activeSessionId);
    }

    employee.status = 'idle';
    employee.currentTask = '';
    employee.activeSessionId = '';
    employee.sdkSessionId = '';
    employee.lastActivity = new Date();
    employee.lastAssignedAt = new Date();
    await employee.save();

    // Boot self-evaluation — tells employee to continue unfinished work, not start over
    const selfEvalTask = `[RESTART — SELF-EVALUATION]
Your session was restarted but your work is NOT lost. Review your context and continue.

YOUR ROLE: ${employee.title} (${employee.role})

YOUR RECENT TASK HISTORY:
${recentTasks || 'No previous tasks.'}

${pendingTasks ? `UNFINISHED TASKS (still in progress — NOT cancelled):\n${pendingTasks}\n` : ''}
${lastWS ? `YOUR LAST WORKING STATUS:\n${lastWS}` : 'You had no working status set.'}

INSTRUCTIONS:
1. Read your task history and last working status above.
2. If you need more context: curl -s http://localhost:3777/api/employees/${employeeId}/self/status-history?limit=5
3. UPDATE YOUR WORKING STATUS within 60 seconds:
   - If your tasks are DONE: set status to "done and idle"
   - If tasks are UNFINISHED: describe what's left and CONTINUE WORKING on them
4. DO NOT redo work that's already done. Check what exists first (ls the project root).
5. DO NOT read .agents/ files — your task history and status history have everything.`;

    this.assignTask(userId, employeeId, selfEvalTask, () => {}).catch(() => {});

    return { message: `${employee.name} restarted — session was dead, booting with self-evaluation.` };
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

  /** Batch set skills for a role — updates the role-level persistence AND all existing employees of that role */
  async setRoleSkills(userId: string, role: string, skills: IEmployeeSkill[]): Promise<{ updated: number }> {
    // Save to role-level persistence
    await UserRoleSkills.findOneAndUpdate(
      { userId, role },
      { skills },
      { upsert: true },
    );

    // Update all existing employees of this role
    const result = await Employee.updateMany(
      { userId, role },
      { skills },
    );

    return { updated: result.modifiedCount || 0 };
  }

  /** Public accessor for locally installed Claude Code skills */
  getLocalSkills(): { name: string; description: string }[] {
    return this.discoverLocalSkills();
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
    const statusDir = path.join(cwd, '.agents', 'status');
    if (!fs.existsSync(statusDir)) {
      fs.mkdirSync(statusDir, { recursive: true });
    }
    const taskResultsDir = path.join(cwd, '.agents', 'task-results');
    if (!fs.existsSync(taskResultsDir)) {
      fs.mkdirSync(taskResultsDir, { recursive: true });
    }

    // Level 1-2: Auto-provision .claude/settings.local.json with permission allowlist
    this.ensureClaudeSettings(cwd);

    // Level 3: Auto-provision helper scripts
    this.ensureWriteFileHelper(cwd);
    this.ensureApiHelper(cwd);
  }

  /** Level 1-2: Create/update .claude/settings.local.json in the project cwd so agents can run without permission blocks */
  private ensureClaudeSettings(cwd: string): void {
    const claudeDir = path.join(cwd, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Always overwrite with the reference config to ensure consistency
    fs.writeFileSync(settingsFile, JSON.stringify(REFERENCE_SETTINGS_LOCAL, null, 2), 'utf-8');

    // Ensure .mcp.json exists at project root with Playwright MCP server
    const mcpFile = path.join(cwd, '.mcp.json');
    const mcpConfig = {
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
      },
    };
    try {
      if (fs.existsSync(mcpFile)) {
        const existing = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
        if (!existing.mcpServers?.playwright) {
          existing.mcpServers = { ...existing.mcpServers, ...mcpConfig.mcpServers };
          fs.writeFileSync(mcpFile, JSON.stringify(existing, null, 2), 'utf-8');
        }
      } else {
        fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      }
    } catch { /* ignore — non-critical */ }

    // Also ensure the project is trusted in ~/.claude.json
    this.ensureProjectTrusted(cwd);
  }

  /** Add a project to ~/.claude.json as trusted so the SDK doesn't block commands.
   *  Retries up to 3 times if the file is locked by a concurrent process. */
  private ensureProjectTrusted(cwd: string): void {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const claudeJsonPath = path.join(homeDir, '.claude.json');

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (!fs.existsSync(claudeJsonPath)) return;

        const config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        if (!config.projects) config.projects = {};

        // Normalize path — try both forward-slash variants
        const normalizedCwd = cwd.replace(/\\/g, '/');

        const entry = config.projects[normalizedCwd] || config.projects[cwd];
        const hasTrust = entry?.hasTrustDialogAccepted === true;
        const hasAllTools = Array.isArray(entry?.allowedTools)
          && REFERENCE_GLOBAL_TOOLS.every((t: string) => entry.allowedTools.includes(t));

        // Always ensure Playwright MCP server is configured
        const globalMcp = config.mcpServers || {};
        const playwrightMcp = globalMcp.playwright || {
          type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {},
        };

        const hasMcp = entry?.mcpServers?.playwright;

        if (!hasTrust || !hasAllTools || !hasMcp) {
          const existing = entry || {};
          const existingMcp = existing.mcpServers || {};
          const mergedEntry = {
            mcpContextUris: [],
            enabledMcpjsonServers: ['playwright'],
            disabledMcpjsonServers: [],
            projectOnboardingSeenCount: 1,
            hasClaudeMdExternalIncludesApproved: false,
            hasClaudeMdExternalIncludesWarningShown: false,
            ...existing,
            mcpServers: { ...existingMcp, playwright: playwrightMcp },
            allowedTools: REFERENCE_GLOBAL_TOOLS,
            hasTrustDialogAccepted: true,
          };
          config.projects[normalizedCwd] = mergedEntry;
          // Remove duplicate backslash-path entry if it exists separately
          if (cwd !== normalizedCwd && config.projects[cwd]) {
            delete config.projects[cwd];
          }
          fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), 'utf-8');
        }

        // Verify the write succeeded by re-reading
        const verify = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        const verified = verify.projects?.[normalizedCwd];
        if (verified?.hasTrustDialogAccepted && Array.isArray(verified?.allowedTools) && verified.allowedTools.includes('Bash(*)')) {
          return; // Success — verified
        }
        // Verification failed — retry
        console.warn(`[ClaudeConfig] Trust verification failed for ${normalizedCwd}, attempt ${attempt}/${MAX_RETRIES}`);
      } catch (err: any) {
        console.warn(`[ClaudeConfig] ensureProjectTrusted attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          // Brief sync delay before retry (file might be locked by concurrent write)
          const start = Date.now();
          while (Date.now() - start < 200 * attempt) { /* busy wait */ }
        }
      }
    }
    console.error(`[ClaudeConfig] Failed to trust project after ${MAX_RETRIES} attempts: ${cwd}`);
  }

  /**
   * Validate that a project's .claude configuration matches the reference config.
   * Compares both settings.local.json and ~/.claude.json trust entry.
   * Returns { valid, issues[] }. If invalid, automatically fixes the config.
   */
  private validateClaudeConfig(cwd: string): { valid: boolean; issues: string[]; fixed: boolean } {
    const issues: string[] = [];
    let fixed = false;
    const normalizedCwd = cwd.replace(/\\/g, '/');

    // 1. Check .claude/settings.local.json
    const claudeDir = path.join(cwd, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');

    try {
      if (!fs.existsSync(settingsFile)) {
        issues.push(`Missing ${settingsFile}`);
      } else {
        const current = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        const refAllow = REFERENCE_SETTINGS_LOCAL.permissions.allow;
        const curAllow: string[] = current?.permissions?.allow || [];

        const missing = refAllow.filter((t: string) => !curAllow.includes(t));
        if (missing.length > 0) {
          issues.push(`settings.local.json missing ${missing.length} permissions: ${missing.join(', ')}`);
        }
      }
    } catch (err: any) {
      issues.push(`settings.local.json unreadable: ${err.message}`);
    }

    // 2. Check ~/.claude.json trust entry
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const claudeJsonPath = path.join(homeDir, '.claude.json');

    try {
      if (fs.existsSync(claudeJsonPath)) {
        const config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        const entry = config.projects?.[normalizedCwd] || config.projects?.[cwd];

        if (!entry) {
          issues.push(`No entry in ~/.claude.json for ${normalizedCwd}`);
        } else {
          if (!entry.hasTrustDialogAccepted) {
            issues.push('hasTrustDialogAccepted is false');
          }
          const missingTools = REFERENCE_GLOBAL_TOOLS.filter((t: string) => !entry.allowedTools?.includes(t));
          if (missingTools.length > 0) {
            issues.push(`~/.claude.json missing ${missingTools.length} tools: ${missingTools.slice(0, 5).join(', ')}${missingTools.length > 5 ? '...' : ''}`);
          }
        }
      }
    } catch (err: any) {
      issues.push(`~/.claude.json unreadable: ${err.message}`);
    }

    // 3. Auto-fix if any issues found
    if (issues.length > 0) {
      console.warn(`[ClaudeConfig] Config mismatch for ${normalizedCwd}: ${issues.join('; ')} — auto-fixing`);
      this.ensureClaudeSettings(cwd);
      fixed = true;
    }

    return { valid: issues.length === 0, issues, fixed };
  }

  /** Build skills context for the employee prompt — includes assigned skills + local Claude Code slash commands */
  private buildSkillsContext(employee: IEmployee, cwd: string): string {
    const sections: string[] = [];

    // 1. Employee's assigned skills (from DB) — MANDATORY
    if (employee.skills?.length) {
      sections.push('YOUR ASSIGNED SKILLS (MANDATORY — YOU MUST USE THESE):');
      sections.push('These skills have been specifically assigned to you. You MUST read and follow them.');
      sections.push('');
      for (const s of employee.skills) {
        sections.push(`  SKILL: ${s.name} — ${s.description}`);
        // Copy the skill file into the workspace so the employee can Read it
        const skillFile = this.copySkillToWorkspace(s.name, cwd);
        if (skillFile) {
          sections.push(`    📖 READ this file FIRST: ${skillFile}`);
          sections.push(`    This file contains the full skill guide. Use the Read tool to load it before starting work.`);
        }
        if (s.prompt) sections.push(`    Additional instructions: ${s.prompt.substring(0, 300)}${s.prompt.length > 300 ? '...' : ''}`);
      }
      sections.push('');
      sections.push('HOW TO USE SKILLS:');
      sections.push('  1. Use the Read tool to read each skill file listed above');
      sections.push('  2. Follow the guidelines in the skill file when doing your work');
      sections.push('  3. DO NOT try to call /skill-name as a command — it will not work');
      sections.push('  4. The skill files are reference documents — read them and apply the knowledge');
      sections.push('Failure to read and apply your assigned skills is a policy violation.');
    }

    // 2. Discover locally installed Claude Code slash commands
    const localSkills = this.discoverLocalSkills();
    if (localSkills.length) {
      sections.push('');
      sections.push('ADDITIONAL AVAILABLE SKILLS (installed locally — use when helpful):');
      for (const s of localSkills) {
        const copied = this.copySkillToWorkspace(s.name, cwd);
        if (copied) {
          sections.push(`  ${s.name}: ${s.description} → Read file: ${copied}`);
        } else {
          sections.push(`  ${s.name}: ${s.description}`);
        }
      }
      sections.push('');
      sections.push('These are optional. Use Read tool to load the skill file when relevant to your work.');
    }

    if (!sections.length) return '';
    return '\n' + sections.join('\n') + '\n';
  }

  /** Discover locally installed Claude Code skills from ~/.claude/commands/ */
  private discoverLocalSkills(): { name: string; description: string }[] {
    const skills: { name: string; description: string }[] = [];
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const commandsDir = path.join(homeDir, '.claude', 'commands');

    try {
      if (!fs.existsSync(commandsDir)) return skills;

      const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const name = file.replace('.md', '');
        try {
          const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8');
          // Extract first line or description from the file
          const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))?.trim() || '';
          const description = firstLine.substring(0, 120);
          skills.push({ name, description });
        } catch {
          skills.push({ name, description: '' });
        }
      }
    } catch {}

    // Also check ~/.claude/skills/ for directories (skill packages)
    const skillsDir = path.join(homeDir, '.claude', 'skills');
    try {
      if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !skills.some(s => s.name === entry.name)) {
            // Look for a SKILL.md or README.md inside
            const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
            const readme = path.join(skillsDir, entry.name, 'README.md');
            let desc = '';
            const descFile = fs.existsSync(skillMd) ? skillMd : fs.existsSync(readme) ? readme : null;
            if (descFile) {
              const content = fs.readFileSync(descFile, 'utf-8');
              const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))?.trim() || '';
              desc = firstLine.substring(0, 120);
            }
            skills.push({ name: entry.name, description: desc });
          }
        }
      }
    } catch {}

    return skills;
  }

  /** Copy a skill file into the workspace's .agents/skills/ so the employee can Read it */
  private copySkillToWorkspace(skillName: string, cwd: string): string | null {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';

      // Check ~/.claude/skills/<skillName>/SKILL.md
      const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
      const skillMd = path.join(skillDir, 'SKILL.md');

      // Check ~/.claude/commands/<skillName>.md
      const commandMd = path.join(homeDir, '.claude', 'commands', `${skillName}.md`);

      let sourcePath: string | null = null;
      if (fs.existsSync(skillMd)) sourcePath = skillMd;
      else if (fs.existsSync(commandMd)) sourcePath = commandMd;
      else return null;

      const destDir = path.join(cwd, '.agents', 'skills');
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const destPath = path.join(destDir, `${skillName}.md`);

      // Only copy if source is newer or dest doesn't exist
      if (!fs.existsSync(destPath) || fs.statSync(sourcePath).mtimeMs > fs.statSync(destPath).mtimeMs) {
        fs.copyFileSync(sourcePath, destPath);
      }

      return `.agents/skills/${skillName}.md`;
    } catch {
      return null;
    }
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

  /** Auto-provision scripts/api.js — HTTP request helper for employees */
  private ensureApiHelper(cwd: string): void {
    const scriptsDir = path.join(cwd, 'scripts');
    const helperFile = path.join(scriptsDir, 'api.js');

    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }

    const script = `// Auto-generated API helper for Claude Code agents
// Usage:
//   node scripts/api.js status <employeeId> "your markdown status here"
//   node scripts/api.js task-done <employeeId> <taskId> "result description"
//   node scripts/api.js task-update <employeeId> <taskId> "updated result"
//   node scripts/api.js idle <employeeId>
//   node scripts/api.js get <path>
//   node scripts/api.js post <path> '{"key":"value"}'

const http = require('http');
const [,, cmd, ...args] = process.argv;
const BASE = 'http://localhost:3777/api/employees';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    }).on('error', reject);
  });
}

(async () => {
  try {
    let result;
    switch (cmd) {
      case 'status': {
        const [empId, ...statusParts] = args;
        result = await post(BASE + '/' + empId + '/self/working-status', { status: statusParts.join(' ') });
        break;
      }
      case 'task-done': {
        const [empId, taskId, ...resultParts] = args;
        result = await post(BASE + '/' + empId + '/self/task-done', { taskId, result: resultParts.join(' ') });
        break;
      }
      case 'task-update': {
        const [empId, taskId, ...resultParts] = args;
        result = await post(BASE + '/' + empId + '/self/task-update', { taskId, result: resultParts.join(' ') });
        break;
      }
      case 'idle': {
        const [empId] = args;
        result = await post(BASE + '/' + empId + '/self/status', { status: 'idle' });
        break;
      }
      case 'my-status': {
        const [empId] = args;
        const emp = await get(BASE + '/' + empId);
        if (emp && typeof emp === 'object') {
          console.log('=== WORKING STATUS ===');
          console.log(emp.workingStatus || '(none)');
          console.log('\\n=== TASKS ===');
          for (const t of (emp.taskHistory || []).slice(-5).reverse()) {
            const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄';
            console.log(icon + ' [' + t.status + '] ' + t.description);
            if (t.result) console.log('   Result: ' + t.result.substring(0, 200));
          }
          console.log('\\n=== STATUS: ' + emp.status + ' ===');
        }
        process.exit(0);
      }
      case 'get': {
        result = await get('http://localhost:3777' + args[0]);
        break;
      }
      case 'post': {
        result = await post('http://localhost:3777' + args[0], JSON.parse(args[1] || '{}'));
        break;
      }
      default:
        console.error('Commands: status, task-done, task-update, idle, get, post');
        process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) { console.error('Error:', e.message); process.exit(1); }
})();
`;

    // Always overwrite to ensure latest version
    fs.writeFileSync(helperFile, script, 'utf-8');
  }
}
