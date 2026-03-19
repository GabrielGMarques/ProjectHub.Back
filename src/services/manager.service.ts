import fs from 'fs';
import path from 'path';
import { Project } from '../models/project.model';
import { Employee, ROLE_TEMPLATES } from '../models/employee.model';
import { TelemetryEvent } from '../models/telemetry.model';
import { ManagerLog } from '../models/manager-log.model';
import { EmployeeLog } from '../models/employee-log.model';
import { User } from '../models/user.model';
import { telegramBot } from './telegram.service';
import { EmployeeService } from './employee.service';
import { ProjectService } from './project.service';
import { claudeChat } from './claude-proxy.service';

const telegramService = telegramBot;
const employeeService = new EmployeeService();
const projectService = new ProjectService();

export interface ManagerLogEntry {
  timestamp: Date;
  type: 'info' | 'warning' | 'error' | 'action' | 'ai';
  message: string;
}

const managerLog: ManagerLogEntry[] = [];
const MAX_LOG = 200;
const MAX_HISTORY = 50;

// In-memory log (fast, for /manager/log endpoint)
function log(type: ManagerLogEntry['type'], message: string): void {
  managerLog.push({ timestamp: new Date(), type, message });
  if (managerLog.length > MAX_LOG) managerLog.shift();
}

// Persistent 24h log (MongoDB, auto-expires via TTL index)
let _activeUserId: string | null = null;
function persistLog(
  category: 'message' | 'ai_call' | 'action' | 'watchdog' | 'loop' | 'error' | 'voice',
  content: string,
  opts?: { direction?: 'inbound' | 'outbound'; metadata?: Record<string, any>; userId?: string }
): void {
  const userId = opts?.userId || _activeUserId;
  if (!userId) return;
  ManagerLog.create({
    userId, category, content,
    direction: opts?.direction,
    metadata: opts?.metadata,
  }).catch(() => {});
}

export class ManagerService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastResponseAt = 0;   // timestamp of last successful AI response
  private lastUserMsgAt = 0;    // timestamp of last user message

  // State tracking — avoid duplicate notifications and unnecessary AI calls
  private lastSnapshot = {
    workingIds: new Set<string>(),        // employees working last check
    reportedCompleted: new Set<string>(), // taskIds already reported as done
    reportedFailed: new Set<string>(),    // taskIds already reported as failed
    lastErrorCount: 0,
  };

  getLog(): ManagerLogEntry[] { return [...managerLog]; }
  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.interval) return;
    this.running = true;
    log('info', 'Manager loop started — checking every 5min, watchdog every 30min');
    this.runCheck().catch(() => {});

    // Fast loop: 2min. Checks are cheap DB queries. AI only called on meaningful events.
    this.interval = setInterval(() => this.runCheck().catch(() => {}), 5 * 60 * 1000);

    // Watchdog: every 30min — self-heals if stuck, reflects on past interactions
    this.watchdogInterval = setInterval(() => this.selfHeal().catch(() => {}), 30 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.watchdogInterval) { clearInterval(this.watchdogInterval); this.watchdogInterval = null; }
    this.running = false;
    log('info', 'Manager loop stopped');
  }

  /** Load conversation history from the database */
  private async loadHistory(userId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const user = await User.findById(userId).select('managerChatMessages').lean();
    if (!user?.managerChatMessages?.length) return [];
    return user.managerChatMessages.slice(-MAX_HISTORY).map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  /** Save a message to persistent history */
  private async saveMessage(userId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    await User.findByIdAndUpdate(userId, {
      $push: {
        managerChatMessages: {
          $each: [{ role, content, timestamp: new Date() }],
          $slice: -MAX_HISTORY,
        },
      },
    });
  }

  /** Handle ANY message from Telegram — the manager answers everything */
  async handleMessage(text: string, userId: string): Promise<string> {
    _activeUserId = userId;
    log('info', `Bruce: ${text}`);
    this.lastUserMsgAt = Date.now();
    persistLog('message', text, { direction: 'inbound', userId });

    // Build full system context
    const context = await this.buildContext(userId);

    // Load persisted conversation history + append new message
    const history = await this.loadHistory(userId);
    history.push({ role: 'user', content: text });

    // Save user message to DB immediately
    await this.saveMessage(userId, 'user', text);

    try {
      const startTime = Date.now();
      persistLog('ai_call', 'Calling Claude Agent SDK', { userId, metadata: { promptLength: context.length, historyLength: history.length } });
      const response = await this.callAI(context, history);
      const elapsed = Date.now() - startTime;
      this.lastResponseAt = Date.now();
      log('info', `AI responded in ${(elapsed / 1000).toFixed(1)}s`);
      persistLog('ai_call', `AI responded in ${(elapsed / 1000).toFixed(1)}s`, { userId, metadata: { durationMs: elapsed, responseLength: response.length } });

      // Parse and execute any actions
      const { cleanResponse, actions } = this.parseActions(response);
      const actionResults: string[] = [];

      for (const action of actions) {
        try {
          persistLog('action', `Executing: ${action.action}`, { userId, metadata: action });
          const result = await this.executeAction(action, userId);
          actionResults.push(`✅ ${result}`);
          log('action', result);
          persistLog('action', `✅ ${result}`, { userId });
        } catch (err: any) {
          actionResults.push(`❌ ${err.message}`);
          log('error', `Action failed: ${err.message}`);
          persistLog('error', `Action failed: ${err.message}`, { userId, metadata: { action } });
        }
      }

      let finalResponse = cleanResponse;
      if (actionResults.length) {
        finalResponse += '\n\n' + actionResults.join('\n');
      }

      // Save assistant response to DB
      await this.saveMessage(userId, 'assistant', finalResponse);
      persistLog('message', finalResponse, { direction: 'outbound', userId });
      log('ai', finalResponse.substring(0, 200));

      return finalResponse;
    } catch (err: any) {
      const errMsg = err.message || 'Unknown error';
      log('error', `AI failed: ${errMsg}`);
      persistLog('error', `AI call failed: ${errMsg}`, { userId, metadata: { stack: err.stack?.substring(0, 500) } });

      if (errMsg.includes('timed out')) {
        const msg = '⚠️ That one took too long, Bruce. Try me again — keep it to one thing at a time and I\'ll be faster.';
        persistLog('message', msg, { direction: 'outbound', userId });
        return msg;
      }

      return `⚠️ Hit a snag, Bruce: ${errMsg.substring(0, 100)}. Give me another shot.`;
    }
  }

  /** Clear conversation history */
  async clearHistory(userId: string): Promise<void> {
    await User.findByIdAndUpdate(userId, { managerChatMessages: [] });
  }

  /** Get conversation history for API/frontend */
  async getHistory(userId: string): Promise<{ role: string; content: string; timestamp: Date }[]> {
    const user = await User.findById(userId).select('managerChatMessages').lean();
    return (user?.managerChatMessages || []).map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));
  }

  /** Build full system context for the AI */
  private async buildContext(userId: string): Promise<string> {
    const projects = await Project.find({ userId });
    const employees = await Employee.find({ userId });
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);
    const recentErrors = await TelemetryEvent.find({
      userId, type: 'error', createdAt: { $gte: oneHourAgo },
    }).sort({ createdAt: -1 }).limit(5).lean();
    const recentTasks = await TelemetryEvent.find({
      userId, type: { $in: ['agent_run', 'employee_task'] }, createdAt: { $gte: oneHourAgo },
    }).sort({ createdAt: -1 }).limit(10).lean();

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    let ctx = `You are Commissioner Gordon — the Manager of ProjectsHub. The user is Bruce — your closest ally, the one you answer to. You two go way back. You're loyal to the bone, sharp, and you never sleep on the job. You call him "Bruce" — never "boss", never "sir", never "Batman". You talk to him like a trusted old friend who also happens to be the one calling the shots. Casual but focused. When Bruce asks, you deliver — fast, no fluff, no excuses. You oversee ALL projects, employees, and operations. You have complete control and can do anything in the system. If something goes wrong on your watch, you own it and fix it before Bruce even has to ask.\n\n`;

    ctx += `CURRENT TIME: ${now.toISOString()}\n\n`;

    // Projects
    ctx += `=== PROJECTS (${projects.length}) ===\n`;
    for (const p of projects) {
      const pEmps = employees.filter(e => e.projectId.toString() === p._id.toString());
      const weeklyHours = days.reduce((s, d) => s + ((p.schedule as any)?.[d] || 0), 0);
      const totalTodos = countTodos(p.todos || []);
      const doneTodos = countDone(p.todos || []);

      const allFolders = [...(p.folders || [])];
      if (p.localPath && !allFolders.includes(p.localPath)) allFolders.unshift(p.localPath);

      ctx += `\nProject: ${p.name} (ID: ${p._id})\n`;
      ctx += `  Description: ${p.description || 'N/A'}\n`;
      ctx += `  MRR: $${p.mrr || 0} | Clients: ${p.clientCount || 0} | Impact: ${p.impact}\n`;
      ctx += `  Weekly Hours: ${weeklyHours}h\n`;
      ctx += `  Folders: ${allFolders.length > 0 ? allFolders.join(', ') : 'NONE'}\n`;
      ctx += `  Todos: ${doneTodos}/${totalTodos} done\n`;

      const pending = (p.todos || []).filter((t: any) => !t.done).slice(0, 3);
      if (pending.length) {
        ctx += `  Pending: ${pending.map((t: any) => t.text).join(', ')}\n`;
      }

      ctx += `  Employees (${pEmps.length}):\n`;
      for (const e of pEmps) {
        ctx += `    ${e.avatar} ${e.name} (${e.title}) — ${e.status}`;
        if (e.currentTask) ctx += ` [working]`;
        ctx += ` | ID: ${e._id}\n`;

        // Show only the last task (brief)
        const lastTask = e.taskHistory[e.taskHistory.length - 1];
        if (lastTask) {
          ctx += `      Last: "${lastTask.description.substring(0, 80)}" — ${lastTask.status}\n`;
        }
      }
    }

    // Recent activity
    if (recentTasks.length) {
      ctx += `\n=== RECENT ACTIVITY (last hour) ===\n`;
      for (const t of recentTasks) {
        ctx += `  [${t.status}] ${t.source}: ${t.description?.substring(0, 100)}\n`;
      }
    }

    if (recentErrors.length) {
      ctx += `\n=== RECENT ERRORS ===\n`;
      for (const e of recentErrors) {
        ctx += `  ${e.source}: ${e.error?.substring(0, 150)}\n`;
      }
    }

    // Available roles
    ctx += `\n=== AVAILABLE ROLES FOR HIRING ===\n`;
    for (const r of ROLE_TEMPLATES) {
      ctx += `  ${r.avatar} ${r.role} — ${r.title}\n`;
    }

    ctx += `\n=== ACTIONS ===
You can execute actions by including action blocks in your response. Use this exact format:

\`\`\`manager-action
{"action": "hire", "projectId": "<id>", "role": "<role>"}
\`\`\`

\`\`\`manager-action
{"action": "fire", "employeeId": "<id>"}
\`\`\`

\`\`\`manager-action
{"action": "task", "employeeId": "<id>", "task": "description of what to do"}
\`\`\`

\`\`\`manager-action
{"action": "add_todos", "projectId": "<id>", "items": ["todo 1", "todo 2"]}
\`\`\`

\`\`\`manager-action
{"action": "update_project", "projectId": "<id>", "field": "description|niche|impact|mrr", "value": "new value"}
\`\`\`

\`\`\`manager-action
{"action": "create_project", "name": "Project Name", "description": "description"}
\`\`\`

\`\`\`manager-action
{"action": "list_files", "projectId": "<id>", "path": "optional/relative/path"}
\`\`\`

\`\`\`manager-action
{"action": "read_file", "projectId": "<id>", "path": "relative/path/to/file.ts"}
\`\`\`

\`\`\`manager-action
{"action": "read_employee_logs", "employeeId": "<id>"}
\`\`\`

RULES:
- You are Gordon. The user is Bruce. Talk like a trusted friend — casual but sharp. Call him "Bruce", never "boss/sir/Batman".
- Keep responses SHORT — this is Telegram. 2-3 sentences max unless Bruce asks for detail.
- When Bruce asks you to do something, you do it immediately with the appropriate action block.
- For tasks: employee MUST be "idle" and project MUST have folders.
- Use IDs from the context above.
- You can include multiple actions in one response.
- To inspect files/folders or employee outputs, use list_files and read_file actions.
- You remember past conversations. Reference previous discussions when relevant.
- Be proactive but brief — flag issues, suggest next moves. You never wait to be asked if something's wrong.
- If you notice idle employees that could be working, suggest tasks. Don't let the team slack.
- Never say "I can't" or "I'm not sure" — find a way or explain what's blocking you.`;

    return ctx;
  }

  /** Get a summary of the folder structure (top 2 levels, ignoring node_modules etc) */
  private getFolderSummary(folderPath: string, maxDepth = 2): string {
    try {
      if (!fs.existsSync(folderPath)) return '';
      const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.angular', '.cache']);
      const lines: string[] = [];

      const walk = (dir: string, depth: number, prefix: string) => {
        if (depth > maxDepth || lines.length > 40) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        const filtered = entries.filter(e => !e.name.startsWith('.') || e.name === '.agents')
          .filter(e => !IGNORE.has(e.name))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

        for (const entry of filtered.slice(0, 15)) {
          lines.push(`${prefix}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`);
          if (entry.isDirectory() && depth < maxDepth) {
            walk(path.join(dir, entry.name), depth + 1, prefix + '  ');
          }
        }
        if (filtered.length > 15) lines.push(`${prefix}... and ${filtered.length - 15} more`);
      };

      walk(folderPath, 0, '    ');
      return lines.length > 0 ? lines.join('\n') : '';
    } catch {
      return '';
    }
  }

  /** Read employee communication files */
  private getCommsContent(folderPath: string): string {
    try {
      const commsDir = path.join(folderPath, '.agents', 'comms');
      if (!fs.existsSync(commsDir)) return '';

      const files = fs.readdirSync(commsDir).filter(f => f.endsWith('.md'));
      if (files.length === 0) return '';

      const lines: string[] = [];
      for (const f of files.slice(0, 10)) {
        const content = fs.readFileSync(path.join(commsDir, f), 'utf-8');
        const stat = fs.statSync(path.join(commsDir, f));
        lines.push(`    --- ${f} (${stat.mtime.toLocaleString()}) ---`);
        // Truncate long comms files
        const truncated = content.substring(0, 500);
        lines.push(`    ${truncated}${content.length > 500 ? '...' : ''}`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private async callAI(systemPrompt: string, messages: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
    // 90s timeout for manager responses — keeps Telegram responsive
    return claudeChat({
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      timeoutMs: 90_000,
    });
  }

  private parseActions(response: string): { cleanResponse: string; actions: any[] } {
    const actions: any[] = [];
    const regex = /```manager-action\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      try { actions.push(JSON.parse(match[1].trim())); } catch {}
    }
    const cleanResponse = response.replace(/```manager-action\n[\s\S]*?\n```/g, '').trim();
    return { cleanResponse, actions };
  }

  private async executeAction(action: any, userId: string): Promise<string> {
    switch (action.action) {
      case 'hire': {
        const emp = await employeeService.hire(userId, action.projectId, action.role, action.name);
        return `Hired ${emp.name} (${emp.title})`;
      }
      case 'fire': {
        await employeeService.fire(userId, action.employeeId);
        return `Employee removed`;
      }
      case 'task': {
        // Fire-and-forget: start the task but don't wait for completion
        const emp = await Employee.findOne({ _id: action.employeeId, userId });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'working') throw new Error(`${emp.name} is already working`);

        // Start task in background
        employeeService.assignTask(userId, action.employeeId, action.task, () => {}).then(
          () => telegramService.send(`✅ ${emp.name} finished: "${action.task}"`).catch(() => {}),
          (err) => telegramService.send(`❌ ${emp.name} failed: ${err.message}`).catch(() => {}),
        );
        return `Task assigned to ${emp.name}: "${action.task}"`;
      }
      case 'add_todos': {
        const project = await projectService.findById(action.projectId, userId);
        if (!project) throw new Error('Project not found');
        const newTodos = (action.items || []).map((t: string) => ({ text: t, done: false, children: [] }));
        project.todos.push(...newTodos);
        await project.save();
        return `Added ${newTodos.length} todo(s) to ${project.name}`;
      }
      case 'update_project': {
        const update: any = {};
        if (['mrr', 'clientCount'].includes(action.field)) {
          update[action.field] = Number(action.value) || 0;
        } else {
          update[action.field] = action.value;
        }
        const updated = await projectService.update(action.projectId, userId, update);
        if (!updated) throw new Error('Project not found');
        return `Updated ${action.field} on ${updated.name}`;
      }
      case 'create_project': {
        const p = await projectService.create(userId, { name: action.name, description: action.description || '' });
        return `Created project: ${p.name}`;
      }
      case 'list_files': {
        return this.listFiles(action.projectId, userId, action.path);
      }
      case 'read_file': {
        return this.readFile(action.projectId, userId, action.path);
      }
      case 'read_employee_logs': {
        return this.readEmployeeLogs(action.employeeId, userId);
      }
      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  /** List files in a project folder */
  private async listFiles(projectId: string, userId: string, relativePath?: string): Promise<string> {
    const project = await projectService.findById(projectId, userId);
    if (!project) throw new Error('Project not found');

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) throw new Error('Project has no folders configured');

    const targetDir = relativePath ? path.join(cwd, relativePath) : cwd;

    // Security: ensure we don't escape the project folder
    const resolved = path.resolve(targetDir);
    if (!resolved.startsWith(path.resolve(cwd))) throw new Error('Path outside project folder');

    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${relativePath || '/'}`);

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const IGNORE = new Set(['node_modules', '.git', 'dist', '.angular', '.cache']);

    const items = entries
      .filter(e => !IGNORE.has(e.name))
      .slice(0, 30)
      .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);

    return `Files in ${relativePath || '/'}:\n${items.join('\n')}${entries.length > 30 ? `\n... and ${entries.length - 30} more` : ''}`;
  }

  /** Read a specific file from a project */
  private async readFile(projectId: string, userId: string, relativePath: string): Promise<string> {
    const project = await projectService.findById(projectId, userId);
    if (!project) throw new Error('Project not found');

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) throw new Error('Project has no folders configured');

    const filePath = path.join(cwd, relativePath);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(cwd))) throw new Error('Path outside project folder');

    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${relativePath}`);

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) throw new Error(`${relativePath} is a directory, not a file. Use list_files instead.`);
    if (stat.size > 50000) return `File ${relativePath} is too large (${(stat.size / 1024).toFixed(1)}KB). Here are the first 200 lines:\n` +
      fs.readFileSync(resolved, 'utf-8').split('\n').slice(0, 200).join('\n');

    const content = fs.readFileSync(resolved, 'utf-8');
    return `File: ${relativePath} (${content.split('\n').length} lines)\n\`\`\`\n${content}\n\`\`\``;
  }

  /** Read recent logs for a specific employee */
  private async readEmployeeLogs(employeeId: string, userId: string): Promise<string> {
    const logs = await EmployeeLog.find({ userId, employeeId })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    if (logs.length === 0) return 'No logs found for this employee in the last 24h.';

    const emp = logs[0];
    const lines = [`📋 Logs for ${emp.employeeAvatar} ${emp.employeeName} (${emp.employeeRole}) — last ${logs.length} entries:\n`];

    for (const l of logs.reverse()) {
      const time = new Date(l.createdAt).toLocaleTimeString();
      const icon = l.category === 'task_start' ? '🟢' : l.category === 'task_complete' ? '✅' : l.category === 'task_fail' ? '❌' :
        l.category === 'tool_use' ? '🔧' : l.category === 'error' ? '🚨' : l.category === 'text' ? '💬' : '📝';
      lines.push(`${time} ${icon} [${l.category}] ${l.content.substring(0, 150)}`);
    }

    return lines.join('\n');
  }

  /**
   * Self-healing watchdog — runs every 30min.
   * Detects if the manager got stuck or stopped responding.
   * If there's an unanswered user message, uses AI to reflect and resume.
   * Also checks if the loop itself died and restarts it.
   */
  private async selfHeal(): Promise<void> {
    try {
      // ── 1. Ensure the fast loop is still running ──
      if (!this.interval) {
        log('warning', 'Watchdog: fast loop was dead — restarting');
        persistLog('watchdog', 'Fast loop was dead — restarted');
        this.interval = setInterval(() => this.runCheck().catch(() => {}), 5 * 60 * 1000);
      }

      const user = await User.findOne().sort({ createdAt: 1 });
      if (!user) return;
      const userId = user._id.toString();
      _activeUserId = userId;

      persistLog('watchdog', 'Watchdog tick', { userId });

      // ── 2. Check for unanswered messages ──
      const history = user.managerChatMessages || [];
      const lastMsg = history[history.length - 1];
      const hasUnanswered = lastMsg && lastMsg.role === 'user';
      const unansweredAgeMs = hasUnanswered ? Date.now() - new Date(lastMsg.timestamp).getTime() : 0;

      if (hasUnanswered && unansweredAgeMs > 5 * 60 * 1000) {
        const ageMin = (unansweredAgeMs / 60000).toFixed(0);
        log('warning', `Watchdog: unanswered message from ${ageMin}min ago — recovering`);
        persistLog('watchdog', `Unanswered message detected (${ageMin}min old): "${lastMsg.content.substring(0, 100)}" — recovering`, { userId });

        telegramService.send(`🔄 _Sorry Bruce — I got hung up on your last message. Picking it back up now._`).catch(() => {});

        try {
          persistLog('ai_call', 'Watchdog recovery: calling AI', { userId });
          const context = await this.buildContext(userId);
          const msgHistory = history.slice(-MAX_HISTORY).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
          const startTime = Date.now();
          const response = await this.callAI(context, msgHistory);
          const elapsed = Date.now() - startTime;
          this.lastResponseAt = Date.now();
          persistLog('ai_call', `Watchdog recovery: AI responded in ${(elapsed / 1000).toFixed(1)}s`, { userId, metadata: { durationMs: elapsed } });

          const { cleanResponse, actions } = this.parseActions(response);
          const actionResults: string[] = [];
          for (const action of actions) {
            try {
              persistLog('action', `Watchdog executing: ${action.action}`, { userId, metadata: action });
              const result = await this.executeAction(action, userId);
              actionResults.push(`✅ ${result}`);
              persistLog('action', `Watchdog: ✅ ${result}`, { userId });
            } catch (err: any) {
              actionResults.push(`❌ ${err.message}`);
              persistLog('error', `Watchdog action failed: ${err.message}`, { userId });
            }
          }

          let finalResponse = cleanResponse;
          if (actionResults.length) finalResponse += '\n\n' + actionResults.join('\n');

          await this.saveMessage(userId, 'assistant', finalResponse);
          telegramService.send(finalResponse).catch(() => {});
          persistLog('message', finalResponse, { direction: 'outbound', userId });
          log('info', `Watchdog: recovered and responded`);
        } catch (err: any) {
          log('error', `Watchdog recovery failed: ${err.message}`);
          persistLog('error', `Watchdog recovery failed: ${err.message}`, { userId, metadata: { stack: err.stack?.substring(0, 500) } });
          telegramService.send(`⚠️ Tried to recover but hit another wall: ${err.message.substring(0, 80)}. Still here though, Bruce — send it again.`).catch(() => {});
        }
        return;
      }

      // ── 3. Periodic reflection — check if anything needs attention ──
      const timeSinceLastInteraction = Date.now() - Math.max(this.lastResponseAt, this.lastUserMsgAt);
      if (timeSinceLastInteraction > 30 * 60 * 1000) {
        const employees = await Employee.find({ userId });
        const projects = await Project.find({ userId });
        const idleWithFolders = employees.filter(e => {
          if (e.status !== 'idle') return false;
          const proj = projects.find(p => p._id.toString() === e.projectId.toString());
          const folders = [...(proj?.folders || [])];
          if (proj?.localPath && !folders.includes(proj.localPath)) folders.unshift(proj.localPath);
          return folders.length > 0;
        });
        const working = employees.filter(e => e.status === 'working');

        if (idleWithFolders.length > 0 && working.length === 0) {
          const names = idleWithFolders.slice(0, 3).map(e => `${e.avatar} ${e.name}`).join(', ');
          const msg = `💤 All quiet, Bruce. ${idleWithFolders.length} employee(s) sitting idle: ${names}. Say the word and I'll put them to work.`;
          telegramService.send(msg).catch(() => {});
          persistLog('watchdog', `Idle nudge sent: ${idleWithFolders.length} idle employees`, { userId });
          log('info', 'Watchdog: nudged Bruce about idle employees');
        }
      }

      log('info', 'Watchdog: all clear');
    } catch (err: any) {
      log('error', `Watchdog failed: ${err.message}`);
      persistLog('error', `Watchdog crashed: ${err.message}`, { metadata: { stack: err.stack?.substring(0, 500) } });
    }
  }

  /**
   * Periodic loop check — runs every 5min.
   * ZERO AI tokens used. Pure DB queries + state diff.
   * Only sends Telegram messages when something actually changes.
   */
  async runCheck(): Promise<void> {
    try {
      const user = await User.findOne().sort({ createdAt: 1 });
      if (user) _activeUserId = user._id.toString();
      if (!user) { log('warning', 'No user found'); return; }
      const userId = user._id.toString();

      const employees = await Employee.find({ userId });
      const projects = await Project.find({ userId });
      const now = new Date();
      const snap = this.lastSnapshot;
      const notifications: string[] = [];

      // ── 1. Detect task completions / failures (new since last check) ──
      for (const emp of employees) {
        const project = projects.find(p => p._id.toString() === emp.projectId.toString());
        const pName = project?.name || 'Unknown';

        for (const task of emp.taskHistory) {
          const tid = task.taskId || `${emp._id}-${task.description}`;

          if (task.status === 'completed' && !snap.reportedCompleted.has(tid)) {
            snap.reportedCompleted.add(tid);
            notifications.push(`✅ *${emp.name}* finished on _${pName}_\n📝 "${task.description}"`);
            log('action', `${emp.name} completed: ${task.description}`);
          }

          if (task.status === 'failed' && !snap.reportedFailed.has(tid)) {
            snap.reportedFailed.add(tid);
            const reason = task.result?.substring(0, 100) || 'Unknown';
            notifications.push(`❌ *${emp.name}* failed on _${pName}_\n📝 "${task.description}"\n⚠️ ${reason}`);
            log('error', `${emp.name} failed: ${task.description}`);
          }
        }
      }

      // ── 2. Detect newly started employees (state change: idle → working) ──
      const currentWorking = new Set(employees.filter(e => e.status === 'working').map(e => e._id.toString()));
      for (const emp of employees) {
        const eid = emp._id.toString();
        if (emp.status === 'working' && !snap.workingIds.has(eid)) {
          const project = projects.find(p => p._id.toString() === emp.projectId.toString());
          const lastTask = emp.taskHistory[emp.taskHistory.length - 1];
          notifications.push(`🟢 *${emp.name}* started working on _${project?.name || 'Unknown'}_\n📝 "${lastTask?.description || 'task'}"`);
        }
      }
      snap.workingIds = currentWorking;

      // ── 3. Reset stuck employees (> 35min) ──
      const stale = employees.filter(e => {
        if (e.status !== 'working') return false;
        const lastActive = e.lastActivity || e.hiredAt;
        return now.getTime() - new Date(lastActive).getTime() > 35 * 60 * 1000;
      });

      for (const emp of stale) {
        log('warning', `${emp.avatar} ${emp.name} stuck > 35min — resetting`);
        emp.status = 'idle';
        emp.currentTask = '';
        const lastTask = emp.taskHistory[emp.taskHistory.length - 1];
        if (lastTask?.status === 'in_progress') {
          lastTask.status = 'failed';
          lastTask.result = 'Timed out (manager reset)';
          lastTask.completedAt = now;
        }
        await emp.save();
        notifications.push(`⚠️ *${emp.name}* was stuck > 35min — reset to idle`);
      }

      // ── 4. Error spike detection ──
      const recentErrors = await TelemetryEvent.countDocuments({
        userId, type: 'error', createdAt: { $gte: new Date(now.getTime() - 3600000) },
      });
      if (recentErrors > snap.lastErrorCount + 3) {
        notifications.push(`🚨 Error spike: ${recentErrors} errors in the last hour (was ${snap.lastErrorCount})`);
      }
      snap.lastErrorCount = recentErrors;

      // ── 5. Send batched notifications (no AI tokens, just formatted text) ──
      if (notifications.length > 0) {
        const msg = notifications.join('\n\n');
        telegramService.send(msg).catch(() => {});
        log('info', `Loop: sent ${notifications.length} notification(s)`);
        persistLog('loop', `${notifications.length} notification(s): ${notifications.map(n => n.substring(0, 60)).join(' | ')}`);
      }

      // ── 6. Check for unanswered user messages (pick up where we left off) ──
      const history = user.managerChatMessages || [];
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        const ageMs = now.getTime() - new Date(lastMsg.timestamp).getTime();
        // If unanswered for > 3 min, recover (uses AI tokens — but necessary)
        if (ageMs > 3 * 60 * 1000) {
          log('warning', `Loop: unanswered message (${(ageMs / 60000).toFixed(0)}min) — recovering`);
          persistLog('loop', `Picking up unanswered demand: "${lastMsg.content.substring(0, 80)}"`, { userId });
          telegramService.send(`🔄 _Picking up where I left off, Bruce..._`).catch(() => {});
          try {
            const context = await this.buildContext(userId);
            const msgHistory = history.slice(-MAX_HISTORY).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
            const response = await this.callAI(context, msgHistory);
            this.lastResponseAt = Date.now();
            const { cleanResponse, actions } = this.parseActions(response);
            const actionResults: string[] = [];
            for (const action of actions) {
              try {
                const result = await this.executeAction(action, userId);
                actionResults.push(`✅ ${result}`);
              } catch (err: any) {
                actionResults.push(`❌ ${err.message}`);
              }
            }
            let finalResponse = cleanResponse;
            if (actionResults.length) finalResponse += '\n\n' + actionResults.join('\n');
            await this.saveMessage(userId, 'assistant', finalResponse);
            persistLog('message', finalResponse, { direction: 'outbound', userId });
            telegramService.send(finalResponse).catch(() => {});
            log('info', 'Loop: recovered unanswered demand');
          } catch (err: any) {
            log('error', `Loop recovery failed: ${err.message}`);
            persistLog('error', `Loop recovery failed: ${err.message}`, { userId });
          }
        }
      }

      // ── 7. Prune old reported IDs to prevent memory leak ──
      if (snap.reportedCompleted.size > 500) {
        const arr = Array.from(snap.reportedCompleted);
        snap.reportedCompleted = new Set(arr.slice(-200));
      }
      if (snap.reportedFailed.size > 500) {
        const arr = Array.from(snap.reportedFailed);
        snap.reportedFailed = new Set(arr.slice(-200));
      }

      const working = employees.filter(e => e.status === 'working').length;
      const idle = employees.filter(e => e.status === 'idle').length;
      log('info', `Loop: ${employees.length} employees (${working} working, ${idle} idle, ${stale.length} reset), ${recentErrors} errors/hr`);
    } catch (err: any) {
      log('error', `Loop check failed: ${err.message}`);
      persistLog('error', `Loop crashed: ${err.message}`);
    }
  }
}

function countTodos(todos: any[]): number {
  let c = 0;
  for (const t of todos) { c++; if (t.children?.length) c += countTodos(t.children); }
  return c;
}
function countDone(todos: any[]): number {
  let c = 0;
  for (const t of todos) { if (t.done) c++; if (t.children?.length) c += countDone(t.children); }
  return c;
}

export const managerService = new ManagerService();
