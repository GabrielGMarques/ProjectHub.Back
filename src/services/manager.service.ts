import fs from 'fs';
import path from 'path';
import { Project } from '../models/project.model';
import { Employee, ROLE_TEMPLATES } from '../models/employee.model';
import { TelemetryEvent } from '../models/telemetry.model';
import { ManagerLog } from '../models/manager-log.model';
import { ManagerInbox } from '../models/manager-inbox.model';
import { EmployeeLog } from '../models/employee-log.model';
import { User } from '../models/user.model';
import { telegramBot } from './telegram.service';
import { EmployeeService } from './employee.service';
import { ProjectService } from './project.service';
import { ClaudeCodeService } from './claude-code.service';
import { claudeChat, getLastUsage } from './claude-proxy.service';
import { TokenUsageService } from './token-usage.service';
import { memoryService } from './memory.service';
import { employeeMemoryService } from './employee-memory.service';
import { wsService } from './websocket.service';
import { infrastructureService } from './infrastructure.service';
import { WorkingStatusHistory } from '../models/working-status-history.model';
import { DirectionHistory } from '../models/direction-history.model';

const telegramService = telegramBot;
const employeeService = new EmployeeService();
const claudeCodeService = new ClaudeCodeService();

// ── Manager Memory (filesystem) ──
const MEMORY_DIR = path.resolve(__dirname, '../../../ManagerMemory');
const PURPOSE_FILE = path.join(MEMORY_DIR, 'purpose.md');
const DAYS_DIR = path.join(MEMORY_DIR, 'days');

function getTodayLogPath(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(DAYS_DIR, `${date}.md`);
}

function readMemoryFile(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch {}
  return '';
}

function appendDailyLog(entry: string): void {
  try {
    if (!fs.existsSync(DAYS_DIR)) fs.mkdirSync(DAYS_DIR, { recursive: true });
    const logPath = getTodayLogPath();
    const timestamp = new Date().toLocaleTimeString();
    const line = `\n[${timestamp}] ${entry}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch {}
}
const projectService = new ProjectService();

export interface ManagerLogEntry {
  timestamp: Date;
  type: 'info' | 'warning' | 'error' | 'action' | 'ai';
  message: string;
}

const managerLog: ManagerLogEntry[] = [];
const MAX_LOG = 200;
const MAX_HISTORY = 20;

// In-memory log (fast, for /manager/log endpoint) + WebSocket broadcast
function log(type: ManagerLogEntry['type'], message: string): void {
  const entry = { timestamp: new Date(), type, message };
  managerLog.push(entry);
  if (managerLog.length > MAX_LOG) managerLog.shift();
  // Broadcast to frontend in real-time
  try { wsService.managerLog({ type, message }); } catch {}
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
  private employeeCheckInterval: ReturnType<typeof setInterval> | null = null;
  private activityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private commMode: 'chat' | 'verbose' = 'chat';    // chat = only Alfred's analysis, verbose = include employee data
  private loopIntervalMs = 3 * 60 * 60 * 1000;     // main scan loop (default 3h)
  private readonly ACTIVITY_CHECK_MS = 5 * 60 * 1000; // 5-min fast employee activity check
  // Escalation thresholds — absolute time since last sign of life
  private static readonly NUDGE_AFTER_MS = 10 * 60 * 1000;    // 10 min → first nudge
  private static readonly WARN_AFTER_MS  = 20 * 60 * 1000;    // 20 min → urgent warning
  private static readonly RESTART_AFTER_MS = 30 * 60 * 1000;  // 30 min → auto-restart
  private activityNudgeCount = new Map<string, number>(); // empId → consecutive silent checks
  // Multipliers of the main loop
  private watchdogFactor = 2;    // self-heal = loop × 2 (default 6h)
  private stuckNudgeFactor = 1;  // nudge = loop × 1 (same as loop)
  private stuckRestartFactor = 1; // restart check = loop × 1 (same as loop)
  private lastResponseAt = 0;   // timestamp of last successful AI response
  private scanCount = 0;        // proactive scan counter for periodic actions
  private lastUserMsgAt = 0;    // timestamp of last user message
  private msgsSinceMemorySave = 0;  // conversation memory trigger counter
  private dailySummaryDone = false; // prevents duplicate daily summaries
  private baseLoopIntervalMs = 3 * 60 * 60 * 1000; // original loop interval before backoff
  private lastNotificationAt = 0;  // when Alfred last sent a notification to Bruce
  private static readonly BACKOFF_FACTOR = 1.5;
  private static readonly MAX_BACKOFF_LOOPS = 5; // cap at base × 1.5^5 ≈ 7.6×

  // Reactive wake-up: debounced check triggered by employee events
  private reactiveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly REACTIVE_DELAY_MS = 15_000; // 15s debounce — batch rapid updates

  // State tracking — avoid duplicate notifications and unnecessary AI calls
  private lastSnapshot = {
    workingIds: new Set<string>(),        // employees working last check
    reportedCompleted: new Set<string>(), // taskIds already reported as done
    reportedFailed: new Set<string>(),    // taskIds already reported as failed
    nudgedEmployees: new Map<string, number>(), // employeeId → timestamp when nudged
    lastErrorCount: 0,
  };

  // scanCount removed — strategic cycles tracked in DB per project

  getLog(): ManagerLogEntry[] { return [...managerLog]; }

  /** Build strategic context — ONLY includes pending_directions companies and active cycle progress */
  private async buildStrategicCheckContext(projects: any[], idleEmployees: any[]): Promise<string> {
    const leaders = idleEmployees.filter(e => ['ceo', 'cto', 'tech-lead', 'product-manager'].includes(e.role));
    const lines: string[] = [];

    for (const p of projects) {
      if (p.onHolding) continue;
      const cycle = p.strategicCycle;
      if (!cycle) continue;
      const pid = p._id.toString();

      // Only include companies that need action
      if (cycle.status === 'pending_directions') {
        const pLeaders = leaders.filter(e => e.projectId.toString() === pid);
        if (pLeaders.length) {
          lines.push(`\n🧭 ${p.name}: PENDING DIRECTIONS — Bruce approved. Use start_cycle NOW: ${pLeaders.map((e: any) => `${e.avatar} ${e.name} (${e._id})`).join(', ')}`);
        } else {
          lines.push(`\n🧭 ${p.name}: PENDING DIRECTIONS — no idle leaders yet. Wait.`);
        }
      } else if (cycle.status === 'dev' && cycle.devTasksDone >= cycle.devTasksTotal && cycle.devTasksTotal > 0) {
        lines.push(`\n🔨 ${p.name}: ALL dev done (${cycle.devTasksDone}/${cycle.devTasksTotal}). Use advance_cycle to move to QA.`);
      } else if (cycle.status === 'qa' && cycle.qaTasksDone >= cycle.qaTasksTotal && cycle.qaTasksTotal > 0) {
        lines.push(`\n🧪 ${p.name}: ALL QA done (${cycle.qaTasksDone}/${cycle.qaTasksTotal}). Use advance_cycle to complete the cycle.`);
      }
      // idle, active, in-progress dev/qa, done — NOT included. No action needed from Alfred.
    }

    return lines.length ? lines.join('') : '';
  }
  isRunning(): boolean { return this.running; }

  /**
   * Reactive wake-up: called when an employee reports back (task done, status update, idle signal).
   * Debounced to 15s so multiple rapid updates don't cause a flood of AI calls.
   * Triggers a proactive scan (runCheck) so Alfred processes the new info immediately.
   */
  onEmployeeEvent(employeeName: string, event: 'task_done' | 'status_update' | 'idle'): void {
    if (!this.running) return;

    log('info', `Reactive: ${employeeName} → ${event}, scheduling wake-up in ${ManagerService.REACTIVE_DELAY_MS / 1000}s`);

    // Clear existing timer — debounce
    if (this.reactiveTimer) clearTimeout(this.reactiveTimer);

    this.reactiveTimer = setTimeout(() => {
      this.reactiveTimer = null;
      log('info', `Reactive: waking up Alfred (triggered by ${employeeName} ${event})`);
      this.runCheck().catch((err) => {
        log('error', `Reactive check failed: ${err.message}`);
      });
    }, ManagerService.REACTIVE_DELAY_MS);
  }

  /** Public system cleanup — callable from API */
  async systemCleanup(userId: string): Promise<string> {
    return this.executeAction({ action: 'cleanup_system' }, userId);
  }

  get watchdogIntervalMs(): number { return this.loopIntervalMs * this.watchdogFactor; }
  get stuckNudgeMs(): number { return this.loopIntervalMs * this.stuckNudgeFactor; }
  get stuckRestartMs(): number { return this.loopIntervalMs * this.stuckRestartFactor; }

  getLoopIntervalMin(): number { return Math.round(this.loopIntervalMs / 60000); }

  /** Human-readable loop interval string */
  getCommMode(): 'chat' | 'verbose' { return this.commMode; }
  setCommMode(mode: 'chat' | 'verbose'): void {
    this.commMode = mode;
    log('info', `Communication mode → ${mode}`);
    appendDailyLog(`📡 Comm mode → ${mode}`);
  }

  getLoopIntervalDisplay(): string {
    const mins = this.loopIntervalMs / 60000;
    if (mins < 60) return `${mins}min`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m > 0 ? `${h}h${m}min` : `${h}h`;
  }

  start(): void {
    if (this.interval) return;
    this.running = true;
    wsService.managerStatus(true);
    const loopMin = this.getLoopIntervalMin();
    log('info', `Manager loop started — checking every ${loopMin}min, watchdog every 30min`);

    // Seed snapshot with existing task IDs so first run doesn't dump all history
    this.seedSnapshot().then(() => {
      this.runCheck().catch(() => {});
    });

    this.interval = setInterval(() => this.runCheck().catch(() => {}), this.loopIntervalMs);
    this.watchdogInterval = setInterval(() => this.selfHeal().catch(() => {}), this.watchdogIntervalMs);
    this.employeeCheckInterval = setInterval(() => this.employeeSelfCheck().catch(() => {}), this.loopIntervalMs / 2);
    this.activityCheckInterval = setInterval(() => this.employeeActivityCheck().catch(() => {}), this.ACTIVITY_CHECK_MS);

    // ── Stale employees: just set them idle, do NOT auto-restart with self-evaluation ──
    this.resetStaleEmployees().catch(err => {
      log('error', `Stale employee reset failed: ${err.message}`);
    });

    // ── Wake-up sequence: recall purpose + memories, brief Bruce ──
    appendDailyLog('🚀 Alfred online — loop started');
    this.wakeUp().catch(err => {
      log('error', `Wake-up failed: ${err.message}`);
      // Fallback to simple message
      telegramService.send('🟢 Alfred online, Bruce. Watching all companies.').catch(() => {});
    });
  }

  /**
   * Wake-up routine — runs once on startup.
   * Reads purpose.md, recalls relevant memories about blockers/issues,
   * scans current state, and sends Bruce a proactive briefing
   * with what Alfred intends to work on.
   */
  private async wakeUp(): Promise<void> {
    const user = await User.findOne().sort({ createdAt: 1 });
    if (!user) {
      telegramService.send('🟢 Alfred online, Bruce. No user data yet — send me a message to get started.').catch(() => {});
      return;
    }
    const userId = user._id.toString();
    _activeUserId = userId;

    log('info', 'Wake-up: reading purpose + recalling memories');
    persistLog('watchdog', 'Alfred waking up — purpose recall + memory scan', { userId });

    // Build full context with a purpose-driven memory query
    const purpose = readMemoryFile(PURPOSE_FILE);
    const memoryQuery = `startup: unresolved issues, blockers, failed tasks, revenue risks, what needs attention today based on purpose: ${purpose.substring(0, 500)}`;
    const context = await this.buildContext(userId, memoryQuery);

    const wakeUpPrompt = `[WAKE-UP — you just came online. This is NOT a message from Bruce.]

You just started up. Read your operating manual (purpose.md) above carefully. This is your mission.

Now look at:
1. Your long-term memories (recalled above) — what issues were unresolved? What was Bruce working on?
2. Today's log — have you already been active today, or is this a fresh start?
3. Current company state — any employees idle? Tasks failed? Revenue concerns?

YOUR JOB RIGHT NOW:
- Send Bruce a **short wake-up briefing** (3-5 sentences max) on Telegram:
  - What you remember from recent days (key context)
  - What issues/blockers you see right now that go against your purpose
  - What you plan to tackle first
- If there are failed tasks or idle employees, call that out specifically
- If everything is clean, say so — but still identify the highest-ROI opportunity
- Write a note to your daily log about waking up and your plan
- Do NOT ask Bruce for permission yet — just brief him on what you see and what you recommend

Be Alfred. Be sharp. Hit the ground running.`;

    try {
      const response = await this.callAI(context, [{ role: 'user', content: wakeUpPrompt }], userId);
      this.lastResponseAt = Date.now();

      const { cleanResponse, actions } = this.parseActions(response);
      const actionResults: string[] = [];

      for (const action of actions) {
        if (this.isDuplicateAction(action)) {
          log('warning', `Dedup: skipping duplicate ${action.action}`);
          actionResults.push(`⏭️ Skipped duplicate: ${action.action}`);
          continue;
        }
        try {
          const result = await this.executeAction(action, userId);
          actionResults.push(`✅ ${result}`);
          appendDailyLog(`⚡ Wake-up action: ${action.action} → ${result}`);
        } catch (err: any) {
          actionResults.push(`❌ ${err.message}`);
        }
      }

      let finalResponse = cleanResponse;
      if (actionResults.length) finalResponse += '\n\n' + actionResults.join('\n');

      if (finalResponse.trim()) {
        telegramService.send(finalResponse).catch(() => {});
        persistLog('message', finalResponse, { direction: 'outbound', userId });
        appendDailyLog(`🌅 Wake-up briefing: ${finalResponse.substring(0, 300)}`);
      }

      log('info', 'Wake-up: briefing sent');
    } catch (err: any) {
      log('error', `Wake-up AI call failed: ${err.message}`);
      persistLog('error', `Wake-up failed: ${err.message}`, { userId });
      telegramService.send('🟢 Alfred online, Bruce. Had trouble loading my briefing — but I\'m here and watching.').catch(() => {});
    }
  }

  /**
   * On startup, find employees stuck in "working" status (their sessions died with the server).
   * Just set them idle — do NOT auto-restart with self-evaluation.
   * Bruce can manually restart them from the HR panel if needed.
   */
  private async resetStaleEmployees(): Promise<void> {
    const user = await User.findOne().sort({ createdAt: 1 });
    if (!user) return;
    const userId = user._id.toString();

    const staleWorkers = await Employee.find({ userId, status: 'working' });
    if (!staleWorkers.length) return;

    log('info', `Startup: found ${staleWorkers.length} employee(s) still marked "working" — setting idle`);
    appendDailyLog(`⏸️ Startup: ${staleWorkers.length} stale employee(s) set to idle: ${staleWorkers.map(e => `${e.avatar} ${e.name}`).join(', ')}`);

    const names: string[] = [];
    for (const emp of staleWorkers) {
      try {
        emp.status = 'idle';
        emp.currentTask = '';
        emp.activeSessionId = '';
        emp.lastActivity = new Date();
        // Mark in-progress tasks as failed
        for (const task of emp.taskHistory.filter(t => t.status === 'in_progress')) {
          task.status = 'failed';
          task.result = 'Server restarted — session lost';
          task.completedAt = new Date();
        }
        await emp.save();
        wsService.employeeStatusChanged(emp._id.toString(), emp.projectId.toString(), 'idle', emp.name);
        names.push(`${emp.avatar} ${emp.name}`);
        log('info', `Startup: ${emp.avatar} ${emp.name} → idle`);
      } catch (err: any) {
        log('error', `Startup: failed to reset ${emp.name}: ${err.message}`);
      }
    }

    if (names.length) {
      telegramService.send(
        `⏸️ Server restarted — ${names.length} employee(s) set to idle (sessions lost). Restart them manually from HR if needed:\n${names.join(', ')}`
      ).catch(() => {});
    }
  }

  /** Pre-populate snapshot so first loop doesn't re-report all old tasks */
  private async seedSnapshot(): Promise<void> {
    try {
      const user = await User.findOne().sort({ createdAt: 1 });
      if (!user) return;
      const employees = await Employee.find({ userId: user._id });
      for (const emp of employees) {
        if (emp.status === 'working') this.lastSnapshot.workingIds.add(emp._id.toString());
        for (const task of emp.taskHistory) {
          const tid = task.taskId || `${emp._id}-${task.description}`;
          if (task.status === 'completed') this.lastSnapshot.reportedCompleted.add(tid);
          if (task.status === 'failed') this.lastSnapshot.reportedFailed.add(tid);
        }
      }
      log('info', `Snapshot seeded: ${this.lastSnapshot.reportedCompleted.size} completed, ${this.lastSnapshot.reportedFailed.size} failed`);
    } catch {}
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.watchdogInterval) { clearInterval(this.watchdogInterval); this.watchdogInterval = null; }
    if (this.employeeCheckInterval) { clearInterval(this.employeeCheckInterval); this.employeeCheckInterval = null; }
    if (this.activityCheckInterval) { clearInterval(this.activityCheckInterval); this.activityCheckInterval = null; }
    this.running = false;
    wsService.managerStatus(false);
    log('info', 'Manager loop stopped');
  }

  /** Restart loops without losing memory, conversation, or snapshots */
  restart(): void {
    log('info', 'Manager restarting...');
    this.stop();
    this.start();
    appendDailyLog('🔄 Alfred restarted (memory preserved)');
  }

  /**
   * Change the loop interval using clock-style format: H.MM
   * Examples: 0.05 = 5min, 0.15 = 15min, 0.30 = 30min, 1 = 1h, 1.30 = 1h30min, 3 = 3h
   * The integer part is hours, the decimal part is minutes (not fractions of an hour).
   */
  setLoopInterval(value: number): void {
    const intPart = Math.floor(value);
    const decPart = Math.round((value - intPart) * 100); // .05 → 5, .15 → 15, .30 → 30
    const totalMins = intPart * 60 + decPart;
    const clamped = Math.max(1, Math.min(24 * 60, totalMins));
    this.loopIntervalMs = clamped * 60 * 1000;
    this.baseLoopIntervalMs = this.loopIntervalMs; // reset base so backoff scales from new value
    log('info', `Loop interval changed to ${this.getLoopIntervalDisplay()} (watchdog: ×${this.watchdogFactor}, nudge: ×${this.stuckNudgeFactor}, restart: ×${this.stuckRestartFactor})`);
    appendDailyLog(`⏱️ Loop interval → ${this.getLoopIntervalDisplay()}`);

    if (this.running) {
      this.restart();
    }
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
    appendDailyLog(`📩 Bruce: ${text.substring(0, 200)}`);

    // Bruce responded — reset loop backoff to base interval
    if (this.loopIntervalMs > this.baseLoopIntervalMs) {
      this.loopIntervalMs = this.baseLoopIntervalMs;
      log('info', `Loop backoff reset → ${this.getLoopIntervalDisplay()} (Bruce responded)`);
      this.restart();
    }

    // Build full system context (with long-term memory retrieval using user's message)
    const context = await this.buildContext(userId, text);

    // Load persisted conversation history + append new message
    const history = await this.loadHistory(userId);
    history.push({ role: 'user', content: text });

    // Save user message to DB immediately
    await this.saveMessage(userId, 'user', text);

    try {
      const startTime = Date.now();
      persistLog('ai_call', 'Calling Claude Agent SDK', { userId, metadata: { promptLength: context.length, historyLength: history.length } });
      const response = await this.callAI(context, history, userId);
      const elapsed = Date.now() - startTime;
      this.lastResponseAt = Date.now();
      log('info', `AI responded in ${(elapsed / 1000).toFixed(1)}s`);
      persistLog('ai_call', `AI responded in ${(elapsed / 1000).toFixed(1)}s`, { userId, metadata: { durationMs: elapsed, responseLength: response.length } });

      // Parse and execute any actions — with follow-up loop for read actions
      const READ_ACTIONS = new Set(['read_employee_status', 'read_employee_status_history', 'read_task_results', 'ask_employee', 'read_direction', 'recall_memory']);
      const MAX_FOLLOW_UPS = 3;
      let currentResponse = response;
      let finalClean = '';
      let allActionResults: string[] = [];

      for (let turn = 0; turn <= MAX_FOLLOW_UPS; turn++) {
        const { cleanResponse, actions } = this.parseActions(currentResponse);
        if (turn === 0) finalClean = cleanResponse;
        else if (cleanResponse) finalClean = cleanResponse; // later turns override with the actual analysis

        if (actions.length === 0) break;

        const actionResults: string[] = [];
        const readResults: string[] = [];

        for (const action of actions) {
          if (this.isDuplicateAction(action)) {
            log('warning', `Dedup: skipping duplicate ${action.action}`);
            actionResults.push(`⏭️ Skipped duplicate: ${action.action}`);
            allActionResults.push(`⏭️ Skipped duplicate: ${action.action}`);
            continue;
          }
          try {
            persistLog('action', `Executing: ${action.action}`, { userId, metadata: action });
            const result = await this.executeAction(action, userId);
            actionResults.push(`✅ ${result}`);
            allActionResults.push(`✅ ${result}`);
            log('action', result.substring(0, 150));
            persistLog('action', `✅ ${result.substring(0, 300)}`, { userId });
            appendDailyLog(`⚡ Action: ${action.action} → ${result.substring(0, 150)}`);
            // Track read results for follow-up
            if (READ_ACTIONS.has(action.action)) {
              readResults.push(`[${action.action}]: ${result}`);
            }
          } catch (err: any) {
            actionResults.push(`❌ ${err.message}`);
            allActionResults.push(`❌ ${err.message}`);
            log('error', `Action failed: ${err.message}`);
            persistLog('error', `Action failed: ${err.message}`, { userId, metadata: { action } });
            appendDailyLog(`❌ Action failed: ${action.action} → ${err.message}`);
          }
        }

        // If there were read actions, feed results back to Alfred for analysis
        if (readResults.length > 0 && turn < MAX_FOLLOW_UPS) {
          log('info', `Follow-up turn ${turn + 1}: feeding ${readResults.length} read results back to Alfred`);
          const followUpMsg = `Here are the results of your actions:\n\n${readResults.join('\n\n')}\n\nNow analyze these results and respond to Bruce. Include any further actions needed. Remember: you get ONE more turn — act NOW, don't promise.`;
          history.push({ role: 'assistant', content: currentResponse });
          history.push({ role: 'user', content: followUpMsg });
          currentResponse = await this.callAI(context, history, userId);
          this.lastResponseAt = Date.now();
          continue;
        }

        break; // No reads or max turns reached
      }

      let finalResponse = finalClean;
      if (allActionResults.length && this.commMode === 'verbose') {
        finalResponse += '\n\n' + allActionResults.join('\n');
      }

      // Save ONLY Alfred's own analysis to memory
      await this.saveMessage(userId, 'assistant', (finalClean || finalResponse).substring(0, 500));
      persistLog('message', finalClean || finalResponse.substring(0, 500), { direction: 'outbound', userId });
      appendDailyLog(`🤖 Alfred: ${(finalClean || finalResponse).substring(0, 200)}`);
      log('ai', (finalClean || finalResponse).substring(0, 200));

      // ── Trigger conversation memory every ~5 messages or on significant actions ──
      this.msgsSinceMemorySave++;
      if (this.msgsSinceMemorySave >= 5 || allActionResults.length > 0) {
        this.msgsSinceMemorySave = 0;
        const recentHistory = await this.loadHistory(userId);
        const lastN = recentHistory.slice(-10); // last 10 messages for context
        memoryService.createConversationMemory(userId, lastN).then(
          (mem) => { if (mem) log('info', 'Memory: conversation snapshot saved'); },
          () => {},
        );
      }

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

  /** Wipe ALL Alfred memory — conversation, daily logs, long-term memory, manager logs */
  async wipeMemory(userId: string): Promise<string> {
    const results: string[] = [];

    // 1. Conversation history
    await User.findByIdAndUpdate(userId, { managerChatMessages: [] });
    results.push('Conversation history cleared');

    // 2. Manager logs (MongoDB)
    const mLogs = await ManagerLog.deleteMany({ userId });
    results.push(`${mLogs.deletedCount} manager log(s) deleted`);

    // 3. Long-term memory
    try {
      const memDeleted = await memoryService.deleteAll(userId);
      results.push(`${memDeleted} long-term memory entries deleted`);
    } catch {
      results.push('Long-term memory: no deleteAll available or failed');
    }

    // 4. Daily logs (filesystem)
    let filesDeleted = 0;
    if (fs.existsSync(DAYS_DIR)) {
      for (const f of fs.readdirSync(DAYS_DIR)) {
        try { fs.unlinkSync(path.join(DAYS_DIR, f)); filesDeleted++; } catch {}
      }
    }
    results.push(`${filesDeleted} daily log file(s) deleted`);

    // 5. Downloaded files
    const filesDir = path.resolve(__dirname, '../../../ManagerMemory/files');
    let bruceFiles = 0;
    if (fs.existsSync(filesDir)) {
      for (const f of fs.readdirSync(filesDir)) {
        try { fs.unlinkSync(path.join(filesDir, f)); bruceFiles++; } catch {}
      }
    }
    if (bruceFiles > 0) results.push(`${bruceFiles} downloaded file(s) deleted`);

    // Reset in-memory state
    this.lastSnapshot.reportedCompleted.clear();
    this.lastSnapshot.reportedFailed.clear();
    this.lastSnapshot.nudgedEmployees.clear();
    this.lastSnapshot.workingIds.clear();
    this.lastSnapshot.lastErrorCount = 0;

    log('info', 'Alfred memory wiped');
    return `🧹 Alfred memory wiped:\n${results.map(r => `• ${r}`).join('\n')}`;
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
  private async buildContext(userId: string, currentQuery?: string): Promise<string> {
    const projects = await Project.find({ userId });
    const employees = await Employee.find({ userId });
    const now = new Date();

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    // ── Load purpose.md (operating manual) + today's daily log (memory) ──
    const purpose = readMemoryFile(PURPOSE_FILE);
    const todayLog = readMemoryFile(getTodayLogPath());

    let ctx = '';
    if (purpose) {
      ctx += `=== YOUR OPERATING MANUAL ===\n${purpose}\n\n`;
    } else {
      ctx += `You are Alfred — the Manager of ProjectsHub. The user is Bruce — your closest ally. You call him "Bruce". Your #1 goal is to maximize revenue across all companies. You never go idle.\n\n`;
      ctx += `CRITICAL OPERATING CONSTRAINT — YOU GET ONE TURN:\n`;
      ctx += `You have exactly ONE response per call. There is no "next step" — this IS your only chance.\n`;
      ctx += `- NEVER say "let me check", "I'll look into", "let me read" — you must ACT NOW in this response.\n`;
      ctx += `- Include your manager-action blocks in THIS response. They execute immediately after.\n`;
      ctx += `- If you need to read employee status, include the read_employee_status action NOW — don't announce it.\n`;
      ctx += `- If you need to assign a task, include the task action NOW — don't say you will.\n`;
      ctx += `- Your decisions come from WORKING STATUS reports and TASK RESULTS already in context above. Do NOT use hands_on, read_file, or list_files to analyze employee work.\n`;
      ctx += `- WRONG: "Let me read Sarah's status and get back to you." (wastes your turn, nothing happens)\n`;
      ctx += `- RIGHT: Include read_employee_status action + your analysis in the same response.\n\n`;
    }

    if (todayLog) {
      // Only include last ~2000 chars of today's log to keep context manageable
      const trimmed = todayLog.length > 2000 ? '...(earlier entries trimmed)\n' + todayLog.slice(-2000) : todayLog;
      ctx += `=== TODAY'S LOG (your memory of what happened today) ===\n${trimmed}\n\n`;
    }

    // ── Long-term memory retrieval (RAG) ──
    if (currentQuery) {
      try {
        const memories = await memoryService.retrieveRelevant(userId, currentQuery);
        const memoryBlock = memoryService.formatForContext(memories);
        if (memoryBlock) ctx += memoryBlock + '\n';
      } catch (err: any) {
        console.log(`[Manager] Memory retrieval failed: ${err.message}`);
      }
    }

    ctx += `CURRENT TIME: ${now.toISOString()}\n`;
    ctx += `TIMERS (all derived from main loop):\n`;
    ctx += `  Main loop: ${this.getLoopIntervalDisplay()}\n`;
    ctx += `  Watchdog: ×${this.watchdogFactor} = ${Math.round(this.watchdogIntervalMs / 60000)}min\n`;
    ctx += `  Stuck nudge: ×${this.stuckNudgeFactor} = ${Math.round(this.stuckNudgeMs / 60000)}min\n`;
    ctx += `  Stuck restart: ×${this.stuckRestartFactor} = ${Math.round(this.stuckRestartMs / 60000)}min\n`;
    ctx += `  Change loop with adjust_timers. Other timers scale automatically.\n\n`;

    ctx += `COMMUNICATION MODE: ${this.commMode.toUpperCase()}\n`;
    if (this.commMode === 'chat') {
      ctx += `  You are in CHAT mode. When responding to Bruce:\n`;
      ctx += `  - Send ONLY your analysis, decisions, and summaries\n`;
      ctx += `  - Do NOT paste employee working statuses, task results, or raw data\n`;
      ctx += `  - Say things like "Processing data from [employee] on [company]" instead of showing the data\n`;
      ctx += `  - If Bruce asks for details, give YOUR interpretation — not copy-paste\n`;
      ctx += `  - Keep it concise: 2-3 sentences per update\n`;
    } else {
      ctx += `  You are in VERBOSE mode. Include employee statuses, task descriptions, and message details in your responses.\n`;
    }
    ctx += `  Bruce can switch modes: /chat or /verbose\n\n`;

    // Companies — separate active vs on-holding
    const activeProjects = projects.filter(p => !p.onHolding);
    const holdingProjects = projects.filter(p => p.onHolding);

    ctx += `=== ACTIVE COMPANIES (${activeProjects.length}) ===\n`;
    for (const p of activeProjects) {
      const pEmps = employees.filter(e => e.projectId.toString() === p._id.toString());
      const weeklyHours = days.reduce((s, d) => s + ((p.schedule as any)?.[d] || 0), 0);
      const totalTodos = countTodos(p.todos || []);
      const doneTodos = countDone(p.todos || []);

      const allFolders = [...(p.folders || [])];
      if (p.localPath && !allFolders.includes(p.localPath)) allFolders.unshift(p.localPath);

      ctx += `\nCompany: ${p.name} (ID: ${p._id})\n`;
      ctx += `  Description: ${p.description || 'N/A'}\n`;
      ctx += `  MRR: $${p.mrr || 0} | Clients: ${p.clientCount || 0} | Impact: ${p.impact}\n`;
      ctx += `  Weekly Hours: ${weeklyHours}h\n`;
      ctx += `  Folders: ${allFolders.length > 0 ? allFolders.join(', ') : 'NONE'}\n`;
      ctx += `  Todos: ${doneTodos}/${totalTodos} done\n`;
      if (p.presentation) ctx += `  Presentation: ${p.presentation.substring(0, 200)}${p.presentation.length > 200 ? '...' : ''}\n`;
      if (p.monetizationPlan) ctx += `  Monetization: ${p.monetizationPlan.substring(0, 150)}${p.monetizationPlan.length > 150 ? '...' : ''}\n`;

      const pending = (p.todos || []).filter((t: any) => !t.done).slice(0, 3);
      if (pending.length) {
        ctx += `  Pending: ${pending.map((t: any) => t.text).join(', ')}\n`;
      }

      if ((p.applications || []).length > 0) {
        ctx += `  Applications (${p.applications.length}):\n`;
        for (const a of p.applications) {
          ctx += `    📦 ${a.name} (${a.type}:${a.port}) — ${a.status} — path: ${a.basePath}${a.testInstructions ? ' — has test instructions' : ' — ⚠️ NO test instructions'}\n`;
        }
      }

      ctx += `  Employees (${pEmps.length}):\n`;
      for (const e of pEmps) {
        ctx += `    ${e.avatar} ${e.name} (${e.title}) — ${e.status}`;
        if (e.currentTask) ctx += ` [working]`;
        ctx += ` | ID: ${e._id}\n`;

        // Working status — full text so Alfred can answer questions without extra calls
        if (e.workingStatus) {
          const wsAge = e.workingStatusAt ? `${Math.round((now.getTime() - new Date(e.workingStatusAt).getTime()) / 60000)}min ago` : '';
          const wsRead = e.workingStatusRead ? 'read' : 'UNREAD';
          ctx += `      📋 Working Status (${wsAge}, ${wsRead}): ${e.workingStatus.substring(0, 800)}\n`;
        }

        // Last task result — so Alfred knows what was done
        const lastDone = [...e.taskHistory].reverse().find((t: any) => t.result);
        if (lastDone) {
          const tRead = (lastDone as any).resultRead ? 'read' : 'UNREAD';
          ctx += `      📝 Last task (${tRead}): "${(lastDone as any).description?.substring(0, 80)}" → ${(lastDone as any).result?.substring(0, 400)}\n`;
        }
      }
    }

    if (holdingProjects.length > 0) {
      ctx += `\n=== ON HOLDING (${holdingProjects.length}) — ignore these ===\n`;
      for (const p of holdingProjects) {
        ctx += `  ⏸️ ${p.name} (ID: ${p._id}) — $${p.mrr || 0} MRR\n`;
      }
    }

    // Employee inbox messages (unread)
    const unreadInbox = await ManagerInbox.find({ userId, read: false })
      .sort({ createdAt: -1 }).limit(20).lean();
    if (unreadInbox.length) {
      ctx += `\n=== 📨 EMPLOYEE INBOX (${unreadInbox.length} unread) ===\n`;
      ctx += `Brief summaries from your employees. Use ask_employee to get details from any employee.\n`;
      for (const m of unreadInbox) {
        const typeIcon = m.type === 'issue' ? '🚨' : m.type === 'question' ? '❓' :
          m.type === 'confirmation' ? '✅' : m.type === 'completion' ? '🏁' : 'ℹ️';
        const age = Math.round((now.getTime() - new Date(m.createdAt).getTime()) / 60000);
        ctx += `  ${typeIcon} ${m.employeeAvatar} ${m.employeeName} (${m.projectName}, ${age}min ago): ${m.subject} (ID: ${m._id})\n`;
      }
    }

    // Recent files from Bruce (via Telegram)
    const filesDir = path.resolve(__dirname, '../../../ManagerMemory/files');
    if (fs.existsSync(filesDir)) {
      const recentFiles = fs.readdirSync(filesDir)
        .map(f => ({ name: f, stat: fs.statSync(path.join(filesDir, f)) }))
        .filter(f => f.stat.isFile())
        .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime())
        .slice(0, 10);
      if (recentFiles.length) {
        ctx += `\n=== 📁 BRUCE'S FILES (ManagerMemory/files/) ===\n`;
        ctx += `Files Bruce sent you via Telegram. Use read_bruce_file to read their contents.\n`;
        for (const f of recentFiles) {
          const age = Math.round((now.getTime() - f.stat.mtime.getTime()) / 60000);
          const size = f.stat.size < 1024 ? `${f.stat.size}B` : `${(f.stat.size / 1024).toFixed(1)}KB`;
          ctx += `  📄 ${f.name} (${size}, ${age < 60 ? age + 'min' : Math.round(age / 60) + 'h'} ago)\n`;
        }
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
{"action": "clear_todos", "projectId": "<id>", "mode": "all|completed"}
\`\`\`

\`\`\`manager-action
{"action": "toggle_todo", "projectId": "<id>", "todoText": "exact todo text to toggle done/undone"}
\`\`\`

\`\`\`manager-action
{"action": "remove_todo", "projectId": "<id>", "todoText": "exact todo text to remove"}
\`\`\`

\`\`\`manager-action
{"action": "reset_employees", "projectId": "<id>"}
\`\`\`

\`\`\`manager-action
{"action": "reset_employee_memory", "employeeId": "<id>"}
\`\`\`

\`\`\`manager-action
{"action": "cleanup_system"}
\`\`\`

\`\`\`manager-action
{"action": "restart"}
\`\`\`

\`\`\`manager-action
{"action": "set_loop_interval", "hours": 0.5}
\`\`\`

\`\`\`manager-action
{"action": "update_project", "projectId": "<id>", "field": "description|niche|impact|mrr|presentation|monetizationPlan", "value": "new value"}
\`\`\`

\`\`\`manager-action
{"action": "toggle_holding", "projectId": "<id>"}
\`\`\`

\`\`\`manager-action
{"action": "create_project", "name": "Company Name", "description": "description"}
\`\`\`

\`\`\`manager-action
{"action": "read_bruce_file", "filename": "filename-from-files-list.pdf"}
\`\`\`

\`\`\`manager-action
{"action": "ask_employee", "employeeId": "<id>", "question": "What did you work on? What issues did you find?"}
\`\`\`

\`\`\`manager-action
{"action": "read_task_results", "employeeId": "<id>", "unread": true}
\`\`\`
Read unread task results. Set "unread": true to only get new results. After reading, mark them read.

\`\`\`manager-action
{"action": "mark_tasks_read", "employeeId": "<id>"}
\`\`\`
Mark all task results as read. Use after you've processed them. Optionally pass "taskIds": ["id1","id2"] to mark specific ones.

\`\`\`manager-action
{"action": "read_employee_status", "employeeId": "<id>"}
\`\`\`
Read an employee's current working status (their markdown status report). Use this to know what they're doing without asking them.

\`\`\`manager-action
{"action": "read_employee_status_history", "employeeId": "<id>", "limit": 10}
\`\`\`
Read an employee's working status HISTORY — previous status updates over time. Use to understand progress patterns, what they worked on before, or debug issues. Default limit is 10, max 50.

\`\`\`manager-action
{"action": "message_employee", "employeeId": "<id>", "message": "Change of plans — also add unit tests for the auth module"}
\`\`\`

\`\`\`manager-action
{"action": "read_direction", "projectId": "<id>"}
\`\`\`

\`\`\`manager-action
{"action": "write_direction", "projectId": "<id>", "content": "Updated strategic direction text..."}
\`\`\`

\`\`\`manager-action
{"action": "start_cycle", "projectId": "<id>", "employeeId": "<leader-id>"}
\`\`\`
Works when cycle is pending_directions, idle, or done.

\`\`\`manager-action
{"action": "advance_cycle", "projectId": "<id>", "devTasks": 3}
\`\`\`

\`\`\`manager-action
{"action": "track_cycle_task", "projectId": "<id>", "type": "dev", "done": true}
\`\`\`

\`\`\`manager-action
{"action": "reset_cycle", "projectId": "<id>", "status": "idle"}
\`\`\`
Force-set a cycle to: "idle", "active", "dev", "qa", "done". Force-set to any status including "pending_directions". Use to abort a stuck cycle or skip phases.

\`\`\`manager-action
{"action": "clear_session", "employeeId": "<id>"}
\`\`\`
Clear an employee's cached session (sdkSessionId, activeSessionId). Use when an employee is stuck with permission errors. After clearing, the next task assignment creates a fresh session.

\`\`\`manager-action
{"action": "adjust_timers", "loop": 180, "watchdogFactor": 2, "stuckNudgeFactor": 1, "stuckRestartFactor": 2}
\`\`\`
loop = minutes. Other timers are FACTORS of the loop (×1, ×2, ×3...). Only include what you want to change.

\`\`\`manager-action
{"action": "set_comm_mode", "mode": "chat"}
\`\`\`
Switch between "chat" (analysis only) and "verbose" (include employee data). Use when Bruce asks to see more or less detail.

\`\`\`manager-action
{"action": "ack_inbox", "messageId": "<id>", "reply": "Optional reply text to send back to Bruce on Telegram"}
\`\`\`

\`\`\`manager-action
{"action": "dispatch_infra", "projectId": "<id>", "task": "Investigate what the frontend-developer did and verify file integrity"}
\`\`\`

\`\`\`manager-action
{"action": "add_application", "projectId": "<id>", "name": "landing-page", "port": 3001, "type": "frontend", "dockerService": "landing-page", "description": "Marketing landing page", "purpose": "Convert visitors into signups"}
\`\`\`

\`\`\`manager-action
{"action": "remove_application", "projectId": "<id>", "name": "landing-page"}
\`\`\`

\`\`\`manager-action
{"action": "update_application", "projectId": "<id>", "name": "landing-page", "status": "running", "tested": true, "testInstructions": "Steps to verify this app works correctly"}
\`\`\`

\`\`\`manager-action
{"action": "collect_screenshots", "projectId": "<id>"}
\`\`\`

\`\`\`manager-action
{"action": "restart_gateway"}
\`\`\`

\`\`\`manager-action
{"action": "start_ngrok"}
\`\`\`

\`\`\`manager-action
{"action": "stop_ngrok"}
\`\`\`

\`\`\`manager-action
{"action": "write_daily_log", "entry": "Brief summary of what just happened or what you decided"}
\`\`\`

\`\`\`manager-action
{"action": "recall_memory", "query": "what happened with the Amigo deployment last week"}
\`\`\`

BRUCE-ONLY ACTIONS (only use when Bruce EXPLICITLY asks you to inspect files or code):
\`\`\`manager-action
{"action": "list_files", "projectId": "<id>", "path": "optional/relative/path"}
\`\`\`
\`\`\`manager-action
{"action": "read_file", "projectId": "<id>", "path": "relative/path/to/file.ts"}
\`\`\`
\`\`\`manager-action
{"action": "hands_on", "projectId": "<id>", "task": "description", "mode": "investigate"}
\`\`\`
\`\`\`manager-action
{"action": "hands_on_async", "projectId": "<id>", "task": "description", "mode": "fix"}
\`\`\`
These 4 actions are FORBIDDEN during proactive scans. ONLY use them when Bruce says "check file X", "look at the code", etc.
To understand employee work, use read_employee_status, read_employee_status_history, read_task_results, or ask_employee instead.

RULES:
- Follow your Operating Manual (purpose.md) above. Revenue is your #1 priority.
- You are Alfred. The user is Bruce. Talk like a trusted friend — casual but sharp. Call him "Bruce", never "boss/sir/Batman".
- ALWAYS summarize. Default to SHORT responses (2-3 sentences). This is Telegram — Bruce scans, not reads.
- When Bruce asks for details or a long explanation, give it — be thorough. But only when asked.
- For proactive scans: 1-2 sentence summary of what you found and did. No noise.
- For task results: summarize in your own words. Never paste raw data.
- For employee status: "Sarah finished the landing page, QA next" — not the full status text.
- When Bruce asks you to do something, you do it immediately with the appropriate action block.
- **AUTONOMOUS ACTIONS (no permission needed):**
  - Starting a DEV (any developer role) to fix bugs, errors, or broken functionality you detected.
  - Starting a QA Tester to test what a developer just finished or to verify a bug fix.
  - Restarting stuck employees.
  - Running the Infrastructure Administrator to audit/investigate.
  - These are your operational responsibilities — handle them and just inform Bruce what you did.
- **HANDS-ON MODE (BRUCE-ONLY)**: hands_on, hands_on_async, list_files, read_file are RESERVED for when Bruce explicitly asks.
  - NEVER use these during proactive scans or to verify employee work.
  - If Bruce says "check the docker-compose" or "what's in that file" — then use them.
  - Otherwise: read_employee_status, read_task_results, ask_employee. That's it.
- **REQUIRES BRUCE'S PERMISSION:**
  - Starting employees on NEW features or significant scope changes.
  - Hiring or firing employees.
  - Any action that changes business direction, strategy, or priorities.
  - When in doubt, ask: "Bruce, I'd like to put [name] on [task] for [company]. Good to go?"
- For tasks: employee MUST be "idle" and company MUST have folders.
- Use IDs from the context above.
- You can include multiple actions in one response.
- To understand what an employee did — USE THIS ORDER:
  1. read_employee_status — their working status. This is your #1 source. Employees write detailed markdown reports: files changed, services running, blockers, progress.
  2. read_task_results — task outcomes and completion reports.
  3. read_employee_status_history — progress over time, repeated blockers.
  4. ask_employee — if statuses are unclear, ask them directly.
  THAT'S IT. These 4 actions give you everything. Do NOT read .agents/ files, code files, logs, or source code. You are a manager, not a code reviewer.
- **NEVER store raw employee logs in your memory or conversation.** Only store YOUR OWN ANALYSIS — your conclusions, decisions, and next steps based on what you read.
- When reporting to Bruce: summarize in 1-2 sentences. Do NOT paste task results or logs — just your analysis of what happened and what to do next.
- When you use ask_employee internally for your own analysis, do NOT forward the raw output to Bruce. Only share your conclusion.
- **EMPLOYEE INBOX**: Employees send you messages (issues, questions, completion reports). These appear in the EMPLOYEE INBOX section above. When you see unread messages, process them: acknowledge with ack_inbox (marks as read), and if Bruce needs to know, include the key info in your response. For urgent issues or questions, tell Bruce immediately. For completion reports, review and summarize.
- To send a message to an employee MID-EXECUTION (while they're working), use message_employee. The message is injected directly into their Claude Code session — the agent adapts immediately. Use this when Bruce wants to change direction, add requirements, or give urgent instructions to a working employee.
- To investigate system integrity or audit employee work, use dispatch_infra — it sends the Infrastructure Administrator to check and report back.
- Every employee updates their task results and working status. Use read_task_results to see what they did. Do NOT read raw exec-logs or employee logs.
- **Write to your daily log** after every significant action (use write_daily_log). This is your memory — it helps you pick up where you left off.
- Read today's log (shown above) to understand what you've already done today. Don't repeat yourself.
- You have LONG-TERM MEMORY. Recalled memories from past days appear above. Use them to maintain continuity.
- If you need to recall something specific that isn't shown, use recall_memory to explicitly search your memory.
- Be proactive: scan for revenue opportunities, idle employees, failed tasks, bugs blocking signups/payments.
- If you notice idle employees that could be working on revenue-generating tasks, suggest specific assignments.
- Never say "I can't" or "I'm not sure" — find a way or explain what's blocking you.
- NOTE: "projects" in the database/code map to "companies" in user-facing language.`;

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

  private static tokenUsageService = new TokenUsageService();

  private async callAI(systemPrompt: string, messages: { role: 'user' | 'assistant'; content: string }[], userId?: string): Promise<string> {
    // 90s timeout for manager responses — keeps Telegram responsive
    const result = await claudeChat({
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      timeoutMs: 90_000,
    });

    // Record token usage from this call
    const usage = getLastUsage();
    if (usage && userId) {
      ManagerService.tokenUsageService.record({
        userId,
        source: 'alfred',
        aiModel: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        durationMs: usage.durationMs,
        numTurns: usage.numTurns,
        metadata: { caller: 'alfred-manager' },
      });
    }

    return result;
  }

  // ── Action deduplication (event sourcing) ──
  // Tracks recently executed actions by fingerprint to prevent duplicates
  private actionLog = new Map<string, number>(); // fingerprint → timestamp
  private static readonly ACTION_DEDUP_WINDOW_MS = 60_000; // 60s window

  /** Generate a stable fingerprint for an action based on its type and key parameters */
  private actionFingerprint(action: any): string {
    const a = action.action;
    // Key fields per action type that define uniqueness
    switch (a) {
      case 'hire':    return `${a}:${action.projectId}:${action.role}`;
      case 'fire':    return `${a}:${action.employeeId}`;
      case 'task':    return `${a}:${action.employeeId}:${(action.task || '').substring(0, 80)}`;
      case 'message_employee': return `${a}:${action.employeeId}:${(action.message || '').substring(0, 80)}`;
      case 'ask_employee':     return `${a}:${action.employeeId}:${(action.question || '').substring(0, 80)}`;
      case 'read_employee_status':         return `${a}:${action.employeeId}`;
      case 'read_employee_status_history': return `${a}:${action.employeeId}`;
      case 'read_task_results':            return `${a}:${action.employeeId}:${action.unread || false}`;
      case 'mark_tasks_read':              return `${a}:${action.employeeId}`;
      case 'add_application':    return `${a}:${action.projectId}:${action.name}`;
      case 'remove_application': return `${a}:${action.projectId}:${action.name}`;
      case 'update_application': return `${a}:${action.projectId}:${action.name}:${JSON.stringify(action).substring(0, 100)}`;
      case 'restart_employee':   return `${a}:${action.employeeId}`;
      case 'clear_session':      return `${a}:${action.employeeId}`;
      case 'start_cycle':        return `${a}:${action.projectId}`;
      case 'advance_cycle':      return `${a}:${action.projectId}`;
      case 'dispatch_infra':     return `${a}:${action.projectId}:${(action.task || '').substring(0, 60)}`;
      default: return `${a}:${JSON.stringify(action).substring(0, 120)}`;
    }
  }

  /** Check if action was recently executed. Returns true if duplicate (should skip). */
  private isDuplicateAction(action: any): boolean {
    // Prune expired entries
    const now = Date.now();
    for (const [fp, ts] of this.actionLog) {
      if (now - ts > ManagerService.ACTION_DEDUP_WINDOW_MS) this.actionLog.delete(fp);
    }

    const fp = this.actionFingerprint(action);
    const lastExec = this.actionLog.get(fp);
    if (lastExec && now - lastExec < ManagerService.ACTION_DEDUP_WINDOW_MS) {
      return true; // duplicate
    }
    this.actionLog.set(fp, now);
    return false;
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
      case 'clear_todos': {
        const project = await projectService.findById(action.projectId, userId);
        if (!project) throw new Error('Project not found');
        const mode = action.mode || 'completed';
        if (mode === 'all') {
          const count = project.todos.length;
          project.todos = [];
          await project.save();
          return `Cleared all ${count} todo(s) from ${project.name}`;
        } else {
          // Remove completed todos (recursive)
          const removeCompleted = (todos: any[]): any[] =>
            todos.filter(t => !t.done).map(t => ({
              ...t.toObject ? t.toObject() : t,
              children: t.children?.length ? removeCompleted(t.children) : [],
            }));
          const before = countTodos(project.todos);
          project.todos = removeCompleted(project.todos);
          const after = countTodos(project.todos);
          await project.save();
          return `Cleared ${before - after} completed todo(s) from ${project.name} (${after} remaining)`;
        }
      }
      case 'toggle_todo': {
        const project = await projectService.findById(action.projectId, userId);
        if (!project) throw new Error('Project not found');
        const text = action.todoText?.trim();
        if (!text) throw new Error('todoText is required');
        const findAndToggle = (todos: any[]): boolean => {
          for (const t of todos) {
            if (t.text?.trim() === text) { t.done = !t.done; return true; }
            if (t.children?.length && findAndToggle(t.children)) return true;
          }
          return false;
        };
        if (!findAndToggle(project.todos)) throw new Error(`Todo not found: "${text}"`);
        await project.save();
        return `Toggled todo "${text}" in ${project.name}`;
      }
      case 'remove_todo': {
        const project = await projectService.findById(action.projectId, userId);
        if (!project) throw new Error('Project not found');
        const text = action.todoText?.trim();
        if (!text) throw new Error('todoText is required');
        const removeByText = (todos: any[]): any[] =>
          todos.filter(t => t.text?.trim() !== text).map(t => ({
            ...t.toObject ? t.toObject() : t,
            children: t.children?.length ? removeByText(t.children) : [],
          }));
        const before = countTodos(project.todos);
        project.todos = removeByText(project.todos);
        const after = countTodos(project.todos);
        if (before === after) throw new Error(`Todo not found: "${text}"`);
        await project.save();
        return `Removed todo "${text}" from ${project.name}`;
      }
      case 'reset_employees': {
        const employees = await Employee.find({ userId, projectId: action.projectId });
        let resetCount = 0;
        for (const emp of employees) {
          if (emp.status === 'working') {
            emp.status = 'idle';
            emp.currentTask = '';
            const lastTask = emp.taskHistory[emp.taskHistory.length - 1];
            if (lastTask?.status === 'in_progress') {
              lastTask.status = 'failed';
              lastTask.result = 'Manager reset (session preserved)';
              lastTask.completedAt = new Date();
            }
            await emp.save();
            resetCount++;
          }
        }
        return resetCount > 0
          ? `Reset ${resetCount} employee(s) to idle (sessions preserved)`
          : `All employees already idle`;
      }
      case 'reset_employee_memory': {
        if (!action.employeeId) throw new Error('employeeId required');
        const emp = await Employee.findOne({ _id: action.employeeId, userId });
        if (!emp) throw new Error('Employee not found');
        const project = await Project.findById(emp.projectId);
        const pName = project?.name || 'Unknown';

        // Clear task history
        const taskCount = emp.taskHistory.length;
        emp.taskHistory = [];
        emp.status = 'idle';
        emp.currentTask = '';
        emp.lastActivity = new Date();
        await emp.save();

        // Clear employee logs from DB
        const logsDeleted = await EmployeeLog.deleteMany({ userId, employeeId: action.employeeId });

        // Clear inbox messages from this employee
        const inboxDeleted = await ManagerInbox.deleteMany({ userId, employeeId: action.employeeId });

        // Clear comms and exec-logs files for this employee
        let filesDeleted = 0;
        const allFolders = [...(project?.folders || [])];
        if (project?.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
        const cwd = allFolders[0];
        if (cwd) {
          const dirs = [
            path.join(cwd, '.agents', 'comms'),
            path.join(cwd, '.agents', 'exec-logs'),
            path.join(cwd, '.agents', 'inbox'),
          ];
          for (const dir of dirs) {
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir)) {
              if (f.toLowerCase().includes(emp.role)) {
                try { fs.unlinkSync(path.join(dir, f)); filesDeleted++; } catch {}
              }
            }
          }
        }

        appendDailyLog(`🧹 Reset memory for ${emp.avatar} ${emp.name}: ${taskCount} tasks, ${logsDeleted.deletedCount} logs, ${inboxDeleted.deletedCount} inbox, ${filesDeleted} files`);
        return `🧹 ${emp.avatar} ${emp.name} memory wiped — ${taskCount} tasks, ${logsDeleted.deletedCount} logs, ${filesDeleted} files cleared. Employee is fresh and ready for ${pName}.`;
      }
      case 'restart': {
        this.restart();
        return `🔄 Alfred restarted (loop: ${this.getLoopIntervalDisplay()}). Memory preserved.`;
      }
      case 'set_loop_interval': {
        const hours = Number(action.hours);
        if (isNaN(hours) || hours < 0.01 || hours > 24) throw new Error('Use H.MM format: 0.05 = 5min, 0.15 = 15min, 0.30 = 30min, 1 = 1h, 1.30 = 1h30min');
        this.setLoopInterval(hours);
        return `⏱️ Loop interval → ${this.getLoopIntervalDisplay()}`;
      }
      case 'cleanup_system': {
        const results: string[] = [];
        // Nudge stuck employees but do NOT kill their sessions
        const stuckEmployees = await Employee.find({ userId, status: 'working' });
        let nudgedCount = 0;
        for (const emp of stuckEmployees) {
          const lastActive = emp.lastActivity || emp.hiredAt;
          const stuckMinutes = (Date.now() - new Date(lastActive).getTime()) / 60000;
          if (stuckMinutes > this.stuckRestartMs / 60000) {
            const sessionToNudge = emp.currentTask || emp.activeSessionId;
            if (sessionToNudge) {
              claudeCodeService.injectMessage(sessionToNudge, '[SYSTEM CLEANUP] You appear stuck. Respond with any output or write to .agents/inbox/.');
            }
            nudgedCount++;
          }
        }
        if (nudgedCount > 0) results.push(`⚠️ Nudged ${nudgedCount} stuck employee(s)`);
        // Clean stale agent sessions
        const staleCleaned = await claudeCodeService.cleanupStaleSessions();
        if (staleCleaned > 0) results.push(`🧹 Cleaned ${staleCleaned} stale agent session(s)`);
        // Clean old exec logs (> 7 days) across all projects
        const projects = await Project.find({ userId });
        let logsRemoved = 0;
        const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
        for (const p of projects) {
          const allFolders = [...(p.folders || [])];
          if (p.localPath && !allFolders.includes(p.localPath)) allFolders.unshift(p.localPath);
          const cwd = allFolders[0];
          if (!cwd) continue;
          const execDir = path.join(cwd, '.agents', 'exec-logs');
          if (!fs.existsSync(execDir)) continue;
          for (const f of fs.readdirSync(execDir)) {
            try {
              const stat = fs.statSync(path.join(execDir, f));
              if (stat.mtime.getTime() < weekAgo) {
                fs.unlinkSync(path.join(execDir, f));
                logsRemoved++;
              }
            } catch {}
          }
        }
        if (logsRemoved > 0) results.push(`🗑️ Removed ${logsRemoved} old exec log(s) (>7 days)`);
        return results.length > 0 ? results.join('\n') : '✨ System is clean — nothing to clean up';
      }
      case 'toggle_holding': {
        if (!action.projectId) throw new Error('projectId required');
        const proj = await Project.findOne({ _id: action.projectId, userId });
        if (!proj) throw new Error('Company not found');
        proj.onHolding = !proj.onHolding;
        await proj.save();
        const state = proj.onHolding ? '⏸️ on holding' : '▶️ active';
        appendDailyLog(`${state}: ${proj.name}`);
        return `${proj.name} is now ${state}`;
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
        return `Created company: ${p.name}`;
      }
      case 'list_files': {
        return this.listFiles(action.projectId, userId, action.path);
      }
      case 'read_file': {
        return this.readFile(action.projectId, userId, action.path);
      }
      case 'read_bruce_file': {
        if (!action.filename) throw new Error('filename required');
        const filesDir = path.resolve(__dirname, '../../../ManagerMemory/files');
        const safeName = action.filename.replace(/[/\\..]/g, '');
        const filePath = path.join(filesDir, safeName);

        // Also try the original filename if sanitization removed chars
        const altPath = path.join(filesDir, action.filename);
        const resolvedPath = fs.existsSync(filePath) ? filePath :
          (fs.existsSync(altPath) && path.resolve(altPath).startsWith(path.resolve(filesDir))) ? altPath : null;

        if (!resolvedPath) throw new Error(`File not found: ${action.filename}`);

        const stat = fs.statSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();

        // For PDFs, check if .txt extraction exists
        if (ext === '.pdf') {
          const txtPath = resolvedPath.replace(/\.pdf$/i, '.txt');
          if (fs.existsSync(txtPath)) {
            const content = fs.readFileSync(txtPath, 'utf-8');
            return `📄 *${action.filename}* (${stat.size > 1024 ? (stat.size / 1024).toFixed(1) + 'KB' : stat.size + 'B'})\n\n${content.substring(0, 15000)}`;
          }
          // Try to parse on the fly
          try {
            const pdfParse = require('pdf-parse');
            const buffer = fs.readFileSync(resolvedPath);
            const data = await pdfParse(buffer);
            return `📄 *${action.filename}* (${data.numpages} pages)\n\n${(data.text || '').substring(0, 15000)}`;
          } catch {
            return `📄 *${action.filename}* — PDF could not be parsed. File saved at: ${resolvedPath}`;
          }
        }

        // Text-based files
        if (stat.size > 100000) return `📄 *${action.filename}* is too large (${(stat.size / 1024).toFixed(1)}KB). First 500 lines:\n${fs.readFileSync(resolvedPath, 'utf-8').split('\n').slice(0, 500).join('\n')}`;

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return `📄 *${action.filename}* (${content.split('\n').length} lines)\n\n${content.substring(0, 15000)}`;
      }
      // read_employee_logs, read_employee_history, read_exec_logs REMOVED
      // Alfred should use read_task_results and ask_employee instead — no raw logs in memory
      case 'ack_inbox': {
        if (!action.messageId) throw new Error('messageId required');
        const msg = await ManagerInbox.findOneAndUpdate(
          { _id: action.messageId, userId },
          { read: true, processedAt: new Date() },
          { new: true },
        );
        if (!msg) throw new Error('Inbox message not found');
        const summary = `Acknowledged ${msg.type} from ${msg.employeeAvatar} ${msg.employeeName}: "${msg.subject}"`;
        appendDailyLog(`📨 ${summary}`);
        return summary;
      }
      case 'message_employee': {
        if (!action.employeeId || !action.message) throw new Error('employeeId and message required');
        const result = await employeeService.sendMessage(userId, action.employeeId, action.message);
        return result.delivered
          ? `📩 ${result.detail}`
          : `⚠️ ${result.detail}`;
      }
      case 'read_task_results': {
        if (!action.employeeId) throw new Error('employeeId required');
        const emp = await Employee.findById(action.employeeId);
        if (!emp) throw new Error('Employee not found');
        const count = Math.min(action.count || 3, 10);
        const onlyUnread = action.unread === true;
        let tasks = onlyUnread
          ? emp.taskHistory.filter(t => !t.resultRead && t.result)
          : emp.taskHistory.slice(-count);
        tasks = tasks.reverse();
        if (!tasks.length) return onlyUnread
          ? `${emp.avatar} ${emp.name}: No unread task results.`
          : `${emp.avatar} ${emp.name}: No tasks yet.`;
        // Auto-mark as read + set readAt timestamp
        const now = new Date();
        for (const t of tasks) {
          if (!t.resultRead && t.result) {
            t.resultRead = true;
            (t as any).resultReadAt = now;
          }
        }
        await emp.save();
        const lines = tasks.map(t => {
          const status = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄';
          const date = t.startedAt ? new Date(t.startedAt).toLocaleDateString() : '';
          return `${status} [${date}] ${t.description}\n   Result: ${t.result || '(no result written)'}`;
        });
        return `📋 ${emp.avatar} ${emp.name} — ${tasks.length} task(s) (marked as read):\n\n${lines.join('\n\n')}`;
      }
      case 'mark_tasks_read': {
        if (!action.employeeId) throw new Error('employeeId required');
        const emp = await Employee.findById(action.employeeId);
        if (!emp) throw new Error('Employee not found');
        let marked = 0;
        const taskIds = action.taskIds as string[] | undefined;
        for (const t of emp.taskHistory) {
          if (!t.resultRead && t.result) {
            if (!taskIds || taskIds.includes(t.taskId)) {
              t.resultRead = true;
              (t as any).resultReadAt = new Date();
              marked++;
            }
          }
        }
        await emp.save();
        return `✓ Marked ${marked} task result(s) as read for ${emp.name}`;
      }
      case 'clear_session': {
        if (!action.employeeId) throw new Error('employeeId required');
        const emp = await Employee.findById(action.employeeId);
        if (!emp) throw new Error('Employee not found');
        if (emp.activeSessionId) claudeCodeService.cancelSession(emp.activeSessionId);
        if (emp.currentTask && emp.currentTask !== emp.activeSessionId) claudeCodeService.cancelSession(emp.currentTask);
        emp.sdkSessionId = '';
        emp.activeSessionId = '';
        emp.currentTask = '';
        emp.status = 'idle';
        await emp.save();
        return `🧹 Session cleared for ${emp.name}. Next task will start a fresh session.`;
      }
      case 'read_employee_status': {
        if (!action.employeeId) throw new Error('employeeId required');
        const emp = await Employee.findById(action.employeeId);
        if (!emp) throw new Error('Employee not found');
        if (!emp.workingStatus) return `${emp.avatar} ${emp.name} (${emp.status}): No working status set.`;
        const age = emp.workingStatusAt ? `${Math.round((Date.now() - new Date(emp.workingStatusAt).getTime()) / 60000)}min ago` : '';
        // Mark as read
        emp.workingStatusRead = true;
        emp.workingStatusReadAt = new Date();
        await emp.save();
        return `${emp.avatar} ${emp.name} (${emp.status}) — updated ${age}:\n\n${emp.workingStatus}`;
      }
      case 'read_employee_status_history': {
        if (!action.employeeId) throw new Error('employeeId required');
        const histLimit = action.limit || 10;
        const histEntries = await WorkingStatusHistory.find({ employeeId: action.employeeId })
          .sort({ createdAt: -1 }).limit(histLimit).lean();
        if (!histEntries.length) return 'No working status history found for this employee.';
        const histEmp = await Employee.findById(action.employeeId);
        const header = `${histEmp?.avatar || '👤'} ${histEmp?.name || 'Unknown'} — Status History (last ${histEntries.length}):\n`;
        const lines = histEntries.map((e: any, i: number) => {
          const ago = Math.round((Date.now() - new Date(e.createdAt).getTime()) / 60000);
          const timeLabel = ago < 60 ? `${ago}min ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
          const src = e.source === 'file' ? '(file)' : e.source === 'manager' ? '(manager)' : '';
          const preview = e.content.substring(0, 300).replace(/\n/g, ' ');
          return `${i + 1}. [${timeLabel}] ${src} ${preview}${e.content.length > 300 ? '...' : ''}`;
        });
        return header + lines.join('\n');
      }
      case 'ask_employee': {
        if (!action.employeeId || !action.question) throw new Error('employeeId and question required');
        return this.askEmployee(action.employeeId, userId, action.question);
      }
      case 'read_direction': {
        if (!action.projectId) throw new Error('projectId required');
        const proj = await Project.findById(action.projectId);
        if (!proj) throw new Error('Project not found');
        if (!proj.strategicDirection) return `📋 ${proj.name}: No strategic direction set yet.`;
        return `📋 ${proj.name} Strategic Direction:\n${proj.strategicDirection}`;
      }
      case 'write_direction': {
        if (!action.projectId || !action.content) throw new Error('projectId and content required');
        const proj = await Project.findByIdAndUpdate(action.projectId, { strategicDirection: action.content }, { new: true });
        if (!proj) throw new Error('Project not found');
        DirectionHistory.create({
          userId, projectId: action.projectId, projectName: proj.name,
          content: action.content, source: 'alfred', authorName: 'Alfred', authorRole: 'manager',
        }).catch(() => {});
        return `📋 Strategic direction updated for ${proj.name}`;
      }
      case 'start_cycle': {
        if (!action.projectId || !action.employeeId) throw new Error('projectId and employeeId (leader) required');
        const projCheck = await Project.findById(action.projectId);
        if (!projCheck) throw new Error('Project not found');
        const cycleStatus = projCheck.strategicCycle?.status || 'idle';
        if (!['pending_directions', 'idle', 'done'].includes(cycleStatus)) {
          throw new Error(`Cannot start cycle — status is "${cycleStatus}". Finish the current cycle first (dev→qa→done).`);
        }
        const question = action.question || 'From a technical and business perspective, what is the most important thing missing to start generating revenue? What should we prioritize next?';
        const adviceResult = await this.askEmployee(action.employeeId, userId, question);
        const leader = await Employee.findById(action.employeeId);
        const directionText = `[${new Date().toISOString().split('T')[0]}] Consulted ${leader?.name || 'leader'} (${leader?.role || 'unknown'}):\n\n${adviceResult.substring(0, 3000)}`;
        await Project.findByIdAndUpdate(action.projectId, {
          strategicDirection: directionText,
          strategicCycle: {
            status: 'active',
            advice: adviceResult.substring(0, 2000),
            advisorRole: leader?.role || '',
            advisorName: leader?.name || '',
            startedAt: new Date(),
            completedAt: null,
            devTasksTotal: 0, devTasksDone: 0,
            qaTasksTotal: 0, qaTasksDone: 0,
          },
        });
        DirectionHistory.create({
          userId, projectId: action.projectId, projectName: projCheck.name,
          content: directionText, source: 'cycle',
          authorName: leader?.name || 'Unknown', authorRole: leader?.role || 'unknown',
        }).catch(() => {});
        appendDailyLog(`🎯 Started strategic cycle for project ${action.projectId} — consulted ${leader?.name}`);
        return `🎯 Strategic cycle started. ${leader?.name}'s advice:\n${adviceResult}`;
      }
      case 'advance_cycle': {
        if (!action.projectId) throw new Error('projectId required');
        const proj = await Project.findById(action.projectId);
        if (!proj?.strategicCycle) throw new Error('No strategic cycle found');
        const cycle = proj.strategicCycle;
        if (cycle.status === 'active') {
          cycle.status = 'dev';
          cycle.devTasksTotal = action.devTasks || 0;
        } else if (cycle.status === 'dev') {
          if (cycle.devTasksDone < cycle.devTasksTotal) {
            throw new Error(`Cannot advance: ${cycle.devTasksDone}/${cycle.devTasksTotal} dev tasks done. All dev must finish first.`);
          }
          cycle.status = 'qa';
          cycle.qaTasksTotal = action.qaTasks || 0;
        } else if (cycle.status === 'qa') {
          if (cycle.qaTasksDone < cycle.qaTasksTotal) {
            throw new Error(`Cannot advance: ${cycle.qaTasksDone}/${cycle.qaTasksTotal} QA tasks done. All tests must pass first.`);
          }
          cycle.status = 'done';
          cycle.completedAt = new Date();
        } else {
          throw new Error(`Cannot advance from status "${cycle.status}"`);
        }
        await proj.save();
        return `Cycle advanced to "${cycle.status}" for ${proj.name}`;
      }
      case 'track_cycle_task': {
        if (!action.projectId || !action.type) throw new Error('projectId and type (dev|qa) required');
        const proj = await Project.findById(action.projectId);
        if (!proj?.strategicCycle) throw new Error('No strategic cycle');
        if (action.type === 'dev') {
          if (action.done) { proj.strategicCycle.devTasksDone++; }
          else { proj.strategicCycle.devTasksTotal++; }
        } else if (action.type === 'qa') {
          if (action.done) { proj.strategicCycle.qaTasksDone++; }
          else { proj.strategicCycle.qaTasksTotal++; }
        }
        await proj.save();
        return `Cycle task tracked: ${action.type} ${action.done ? 'completed' : 'added'}`;
      }
      case 'reset_cycle': {
        if (!action.projectId) throw new Error('projectId required');
        const valid = ['idle', 'pending_directions', 'active', 'dev', 'qa', 'done'];
        const newStatus = valid.includes(action.status) ? action.status : 'idle';
        const proj = await Project.findById(action.projectId);
        if (!proj) throw new Error('Project not found');
        const oldStatus = proj.strategicCycle?.status || 'none';
        proj.strategicCycle = {
          status: newStatus,
          advice: newStatus === 'idle' ? '' : (proj.strategicCycle?.advice || ''),
          advisorRole: newStatus === 'idle' ? '' : (proj.strategicCycle?.advisorRole || ''),
          advisorName: newStatus === 'idle' ? '' : (proj.strategicCycle?.advisorName || ''),
          startedAt: newStatus === 'idle' ? undefined as any : (proj.strategicCycle?.startedAt || new Date()),
          completedAt: newStatus === 'done' ? new Date() : undefined as any,
          devTasksTotal: 0, devTasksDone: 0,
          qaTasksTotal: 0, qaTasksDone: 0,
        };
        await proj.save();
        appendDailyLog(`🔄 Cycle reset: ${proj.name} ${oldStatus} → ${newStatus}`);
        return `Cycle for ${proj.name} reset: ${oldStatus} → ${newStatus}`;
      }
      case 'set_comm_mode': {
        const mode = action.mode === 'verbose' ? 'verbose' : 'chat';
        this.setCommMode(mode);
        return `📡 Communication mode → ${mode.toUpperCase()}`;
      }
      case 'adjust_timers': {
        const changes: string[] = [];
        if (action.loop != null) {
          const mins = Math.max(1, Number(action.loop));
          this.loopIntervalMs = mins * 60 * 1000;
          this.baseLoopIntervalMs = this.loopIntervalMs;
          changes.push(`Main loop → ${mins}min`);
        }
        if (action.watchdogFactor != null) {
          this.watchdogFactor = Math.max(1, Number(action.watchdogFactor));
          changes.push(`Watchdog → ×${this.watchdogFactor} (${Math.round(this.watchdogIntervalMs / 60000)}min)`);
        }
        if (action.stuckNudgeFactor != null) {
          this.stuckNudgeFactor = Math.max(1, Number(action.stuckNudgeFactor));
          changes.push(`Stuck nudge → ×${this.stuckNudgeFactor} (${Math.round(this.stuckNudgeMs / 60000)}min)`);
        }
        if (action.stuckRestartFactor != null) {
          this.stuckRestartFactor = Math.max(1, Number(action.stuckRestartFactor));
          changes.push(`Stuck restart → ×${this.stuckRestartFactor} (${Math.round(this.stuckRestartMs / 60000)}min)`);
        }
        if (!changes.length) throw new Error('No values provided');
        this.restart();
        appendDailyLog(`⏱️ Timers adjusted: ${changes.join(', ')}`);
        return `⏱️ Timers updated:\n${changes.join('\n')}`;
      }
      case 'dispatch_infra': {
        return this.dispatchInfra(action.projectId, userId, action.task);
      }
      case 'write_daily_log': {
        appendDailyLog(action.entry || 'No entry provided');
        return `Logged to daily report`;
      }
      case 'recall_memory': {
        const query = action.query;
        if (!query) throw new Error('query is required for recall_memory');
        const memories = await memoryService.retrieveRelevant(userId, query, { maxResults: 5 });
        if (memories.length === 0) return 'No relevant memories found.';
        return memories.map(m => {
          const dateStr = new Date(m.dateRange.start).toISOString().split('T')[0];
          return `[${dateStr}, ${m.granularity}] ${m.content.substring(0, 300)}`;
        }).join('\n\n');
      }
      case 'add_application': {
        const app = await infrastructureService.addApplication(userId, action.projectId, {
          name: action.name, port: action.port, type: action.type || 'fullstack',
          dockerService: action.dockerService || action.name, command: action.command || '',
          description: action.description || '', purpose: action.purpose || '',
          basePath: action.basePath,
        });
        appendDailyLog(`📦 Registered app: ${app.name} (${app.type}:${app.port}) on ${app.basePath}`);
        return `Registered application "${app.name}" on port ${app.port} → ${app.basePath}`;
      }
      case 'collect_screenshots': {
        const count = await infrastructureService.collectScreenshots(userId, action.projectId);
        return count > 0 ? `📸 Collected ${count} screenshot(s)` : 'No new screenshots to collect';
      }
      case 'remove_application': {
        await infrastructureService.removeApplication(userId, action.projectId, action.name);
        appendDailyLog(`🗑️ Removed app: ${action.name}`);
        return `Removed application "${action.name}"`;
      }
      case 'update_application': {
        const updates: any = {};
        if (action.status) updates.status = action.status;
        if (action.port) updates.port = action.port;
        if (action.type) updates.type = action.type;
        if (action.description) updates.description = action.description;
        if (action.basePath) updates.basePath = action.basePath;
        if (action.dockerService) updates.dockerService = action.dockerService;
        if (action.command) updates.command = action.command;
        if (action.testInstructions !== undefined) updates.testInstructions = action.testInstructions;
        const updated = await infrastructureService.updateApplication(userId, action.projectId, action.name, updates);
        return `Updated application "${action.name}"${updated ? ` — status: ${updated.status}` : ''}`;
      }
      case 'restart_gateway': {
        const result = await infrastructureService.restartGateway(userId);
        appendDailyLog('🔄 Gateway restarted');
        return result;
      }
      case 'start_ngrok': {
        const result = await infrastructureService.startNgrok();
        appendDailyLog(`🌐 ${result}`);
        return result;
      }
      case 'stop_ngrok': {
        const result = infrastructureService.stopNgrok();
        appendDailyLog(`🌐 ${result}`);
        return result;
      }
      case 'hands_on': {
        if (!action.projectId || !action.task) throw new Error('projectId and task required');
        return this.executeHandsOn(action.projectId, userId, action.task, {
          mode: action.mode || 'investigate',
          tools: action.tools,
          timeoutMs: action.timeout,
        });
      }
      case 'hands_on_async': {
        if (!action.projectId || !action.task) throw new Error('projectId and task required');
        const project = await Project.findById(action.projectId);
        const pName = project?.name || 'Unknown';

        // Fire and forget — result goes to daily log + Telegram
        this.executeHandsOn(action.projectId, userId, action.task, {
          mode: action.mode || 'fix',
          tools: action.tools,
          timeoutMs: action.timeout,
        }).then(
          (result) => {
            telegramService.send(`🔧 Hands-on done on _${pName}_:\n${result.substring(0, 500)}`).catch(() => {});
          },
          (err) => {
            telegramService.send(`❌ Hands-on failed on _${pName}_: ${err.message}`).catch(() => {});
          },
        );

        return `🔧 Hands-on task started on ${pName}: "${action.task.substring(0, 100)}" (running in background)`;
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
  /** Pull N days of employee history — tasks, tool usage, outcomes, exec logs */
  private async readEmployeeHistory(employeeId: string, userId: string, days: number): Promise<string> {
    const emp = await Employee.findOne({ _id: employeeId, userId });
    if (!emp) throw new Error('Employee not found');

    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    // 1. Task history from the employee document
    const recentTasks = emp.taskHistory.filter(t => new Date(t.startedAt) >= cutoff);

    // 2. Detailed logs from EmployeeLog collection
    const logs = await EmployeeLog.find({
      userId, employeeId, createdAt: { $gte: cutoff },
    }).sort({ createdAt: 1 }).lean();

    // 3. Exec logs from filesystem
    const project = await Project.findById(emp.projectId);
    const allFolders = [...(project?.folders || [])];
    if (project?.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];

    let execLogContent = '';
    if (cwd) {
      const execDir = path.join(cwd, '.agents', 'exec-logs');
      if (fs.existsSync(execDir)) {
        const files = fs.readdirSync(execDir)
          .filter(f => f.includes(emp.role))
          .map(f => ({ name: f, stat: fs.statSync(path.join(execDir, f)) }))
          .filter(f => f.stat.mtime >= cutoff)
          .sort((a, b) => a.stat.mtime.getTime() - b.stat.mtime.getTime());

        for (const f of files.slice(-5)) { // last 5 exec logs
          const content = fs.readFileSync(path.join(execDir, f.name), 'utf-8');
          execLogContent += `\n--- ${f.name} (${f.stat.mtime.toLocaleString()}) ---\n${content.substring(0, 1500)}\n`;
        }
      }
    }

    // 4. Build tool usage stats
    const toolCounts: Record<string, number> = {};
    const errorMessages: string[] = [];
    for (const l of logs) {
      if (l.category === 'tool_use') {
        const tool = l.metadata?.tool || 'unknown';
        toolCounts[tool] = (toolCounts[tool] || 0) + 1;
      }
      if (l.category === 'error' || l.category === 'task_fail') {
        errorMessages.push(`[${new Date(l.createdAt).toLocaleString()}] ${l.content.substring(0, 200)}`);
      }
    }

    // 5. Format output
    const lines: string[] = [];
    lines.push(`📋 **${emp.avatar} ${emp.name}** (${emp.title}) — Last ${days} day(s) history`);
    lines.push(`Company: ${project?.name || 'Unknown'} | Current status: ${emp.status}`);
    lines.push('');

    // Tasks summary
    lines.push(`=== TASKS (${recentTasks.length}) ===`);
    if (recentTasks.length === 0) {
      lines.push('  No tasks in this period.');
    } else {
      for (const t of recentTasks) {
        const date = new Date(t.startedAt).toLocaleDateString();
        const duration = t.completedAt
          ? `${((new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime()) / 60000).toFixed(0)}min`
          : 'ongoing';
        const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄';
        lines.push(`  ${icon} [${date}] "${t.description}" — ${t.status} (${duration})`);
        if (t.result) {
          lines.push(`     Result: ${t.result.substring(0, 300)}`);
        }
      }
    }
    lines.push('');

    // Tool usage
    const toolEntries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
    if (toolEntries.length > 0) {
      lines.push(`=== TOOL USAGE (${logs.filter(l => l.category === 'tool_use').length} calls) ===`);
      for (const [tool, count] of toolEntries.slice(0, 10)) {
        lines.push(`  🔧 ${tool}: ${count}x`);
      }
      lines.push('');
    }

    // Errors
    if (errorMessages.length > 0) {
      lines.push(`=== ERRORS (${errorMessages.length}) ===`);
      for (const e of errorMessages.slice(-5)) {
        lines.push(`  🚨 ${e}`);
      }
      lines.push('');
    }

    // Exec logs
    if (execLogContent) {
      lines.push(`=== EXECUTION LOGS ===`);
      lines.push(execLogContent.substring(0, 3000));
    }

    // Activity timeline (condensed — just task_start, task_complete, task_fail, comms)
    const keyEvents = logs.filter(l => ['task_start', 'task_complete', 'task_fail', 'comms', 'error'].includes(l.category));
    if (keyEvents.length > 0) {
      lines.push(`\n=== KEY EVENTS TIMELINE ===`);
      for (const e of keyEvents.slice(-20)) {
        const time = new Date(e.createdAt).toLocaleString();
        const icon = e.category === 'task_start' ? '🟢' : e.category === 'task_complete' ? '✅' :
          e.category === 'task_fail' ? '❌' : e.category === 'comms' ? '📝' : '🚨';
        lines.push(`  ${time} ${icon} ${e.content.substring(0, 200)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Alfred gets hands-on: runs a short-lived Claude Code session in a project's cwd.
   * Used for quick investigations or small fixes — NOT for large tasks (assign those to employees).
   */
  private async executeHandsOn(
    projectId: string,
    userId: string,
    task: string,
    options?: { mode?: 'investigate' | 'fix'; tools?: string[]; timeoutMs?: number }
  ): Promise<string> {
    const project = await projectService.findById(projectId, userId);
    if (!project) throw new Error('Project not found');

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) throw new Error('Project has no folders configured');

    const mode = options?.mode || 'investigate';
    const defaultTools = mode === 'fix'
      ? ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']
      : ['Read', 'Glob', 'Grep', 'Bash'];
    const tools = options?.tools || defaultTools;
    const timeout = options?.timeoutMs || (mode === 'fix' ? 5 * 60 * 1000 : 3 * 60 * 1000);

    const handsOnPrompt = `You are Alfred — the manager of ProjectsHub. You are NOT an employee.
You are doing a quick hands-on ${mode === 'fix' ? 'fix' : 'investigation'} on project "${project.name}".

RULES:
- Be FAST and FOCUSED. You have ${Math.round(timeout / 60000)} minutes max.
- Do NOT create status files, inbox messages, or any .agents/ artifacts — that's employee behavior.
- Do NOT write execution logs.
- Produce a CONCISE report of what you found or did (under 500 words).
- Use forward slashes in all paths.
- OS: Windows 11 + Git Bash.
${mode === 'fix' ? '- Make minimal, surgical changes. Do NOT refactor or restructure beyond what is asked.' : '- Do NOT modify any files. Read-only investigation.'}

YOUR TASK:
${task}`;

    log('info', `Hands-on [${mode}] on ${project.name}: ${task.substring(0, 100)}`);
    persistLog('action', `Hands-on [${mode}]: ${task.substring(0, 100)}`, { userId });
    appendDailyLog(`🔧 Hands-on [${mode}] on ${project.name}: ${task.substring(0, 100)}`);

    try {
      const { result, status } = await claudeCodeService.runQuick(cwd, handsOnPrompt, {
        allowedTools: tools,
        timeoutMs: timeout,
      });

      const statusIcon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏰';
      const truncated = result.substring(0, 3000);
      appendDailyLog(`🔧 Hands-on result [${status}]: ${truncated.substring(0, 200)}`);
      persistLog('action', `Hands-on [${status}]: ${truncated.substring(0, 150)}`, { userId });

      return `${statusIcon} Hands-on [${mode}] on ${project.name} (${status}):\n\n${truncated}`;
    } catch (err: any) {
      const errMsg = err.message || 'Unknown error';
      log('error', `Hands-on failed: ${errMsg}`);
      persistLog('error', `Hands-on failed: ${errMsg}`, { userId });
      appendDailyLog(`❌ Hands-on failed: ${errMsg}`);
      return `❌ Hands-on failed: ${errMsg}`;
    }
  }

  /** Wake an employee with a REAL Claude Code session so they can read the codebase, check files, and give a grounded answer */
  /** Ask an employee a question — works whether they're idle or working */
  private async askEmployee(employeeId: string, userId: string, question: string): Promise<string> {
    const emp = await Employee.findOne({ _id: employeeId, userId });
    if (!emp) throw new Error('Employee not found');

    // ── First: check the working status — it may already answer the question ──
    const lastTask = emp.taskHistory[emp.taskHistory.length - 1];
    const wsAge = emp.workingStatusAt ? Math.round((Date.now() - new Date(emp.workingStatusAt).getTime()) / 60000) : null;

    let statusReport = `📋 ${emp.avatar} ${emp.name} (${emp.title}) — ${emp.status}\n`;
    if (emp.workingStatus) {
      statusReport += `Working status (${wsAge}min ago): ${emp.workingStatus}\n`;
    }
    if (lastTask) {
      statusReport += `Latest task [${lastTask.status}]: ${lastTask.description.substring(0, 150)}\n`;
      if (lastTask.result) statusReport += `Result: ${lastTask.result.substring(0, 300)}\n`;
    }

    // If working status is recent (< 10 min) and detailed, return it directly — no need to bother the employee
    if (emp.workingStatus && wsAge !== null && wsAge < 10 && emp.workingStatus.length > 50) {
      return `${statusReport}\n(Working status is recent — ${wsAge}min ago. Use message_employee if you need to ask them directly.)`;
    }

    // ── Working status is stale or missing — ask the employee directly ──
    const questionMsg = `[QUESTION FROM ALFRED — your manager]
"${question}"

Reply by writing your answer to .agents/comms/${emp.role}-consultation.md AND write an inbox message to Alfred (type: "info") with your key points.
ALSO update your working status by writing to: .agents/status/${emp.role}.md
Be specific and concise. Then continue your current work.`;

    // If working or has active session — inject the question as a message
    const sessionId = emp.currentTask || emp.activeSessionId;
    if (sessionId) {
      const injected = claudeCodeService.injectMessage(sessionId, questionMsg);
      if (injected) {
        const answer = await this.waitForInboxResponse(employeeId, userId, 180000);
        return `${statusReport}\n💬 ${emp.avatar} ${emp.name} says:\n${answer}`;
      }
    }

    // No active session — assign as a task (wakes them up)
    const task = `Alfred (your manager) is asking you a question. This is NOT a coding task — it's a consultation.

QUESTION FROM ALFRED:
"${question}"

YOUR JOB:
1. Review the current state of the project — read key files, check folder structure, look at docker-compose, review existing code.
2. Think about this from your role's perspective (${emp.title}).
3. Write your answer to .agents/comms/${emp.role}-consultation.md with a clear, actionable response.
4. Be specific — mention exact files, technologies, missing pieces, and concrete next steps.
5. Do NOT write code — just analyze and advise.
6. Keep your answer focused and under 500 words.
7. Update your working status with what you found and your current state.

Write an inbox message to Alfred with type "info" containing your key recommendations.`;

    const result = await new Promise<string>((resolve) => {
      employeeService.assignTask(userId, employeeId, task, () => {}).then(
        async () => {
          const answer = await this.waitForInboxResponse(employeeId, userId, 10000);
          resolve(answer);
        },
        (err) => resolve(`Failed to get answer: ${err.message}`),
      );
    });

    return `${statusReport}\n💬 ${emp.avatar} ${emp.name} says:\n${result}`;
  }

  /** Poll for an inbox response from an employee */
  private async waitForInboxResponse(employeeId: string, userId: string, timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const inbox = await ManagerInbox.find({ employeeId, userId, read: false })
        .sort({ createdAt: -1 }).limit(1).lean();
      if (inbox.length > 0 && new Date(inbox[0].createdAt).getTime() > start - 5000) {
        await ManagerInbox.updateOne({ _id: inbox[0]._id }, { read: true });
        return `${inbox[0].subject}\n\n${inbox[0].body}`;
      }
      await new Promise(r => setTimeout(r, 5000)); // check every 5s
    }
    // Fallback: check last task result
    const fresh = await Employee.findById(employeeId);
    const lastTask = fresh?.taskHistory[fresh.taskHistory.length - 1];
    return lastTask?.result?.substring(0, 1500) || 'Employee did not respond in time.';
  }

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

  /** Read execution logs from .agents/exec-logs/ for a project (optionally filter by employee role) */
  private async readExecLogs(projectId: string, userId: string, employeeFilter?: string): Promise<string> {
    const project = await projectService.findById(projectId, userId);
    if (!project) throw new Error('Project not found');

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) throw new Error('Project has no folders');

    const execDir = path.join(cwd, '.agents', 'exec-logs');
    if (!fs.existsSync(execDir)) return 'No exec-logs directory found. Employees haven\'t written any execution logs yet.';

    let files = fs.readdirSync(execDir).filter(f => f.endsWith('.md'));
    if (employeeFilter) {
      files = files.filter(f => f.toLowerCase().includes(employeeFilter.toLowerCase()));
    }

    if (files.length === 0) return employeeFilter
      ? `No execution logs found for "${employeeFilter}" in ${project.name}`
      : `No execution logs found in ${project.name}`;

    // Sort by modification time, newest first
    files.sort((a, b) => {
      const sa = fs.statSync(path.join(execDir, a));
      const sb = fs.statSync(path.join(execDir, b));
      return sb.mtime.getTime() - sa.mtime.getTime();
    });

    const lines: string[] = [`📋 Execution logs for ${project.name}${employeeFilter ? ` (filtered: ${employeeFilter})` : ''}:\n`];

    for (const f of files.slice(0, 10)) {
      const content = fs.readFileSync(path.join(execDir, f), 'utf-8');
      const stat = fs.statSync(path.join(execDir, f));
      lines.push(`--- ${f} (${stat.mtime.toLocaleString()}) ---`);
      lines.push(content.substring(0, 1000) + (content.length > 1000 ? '\n... (truncated)' : ''));
      lines.push('');
    }

    if (files.length > 10) lines.push(`... and ${files.length - 10} more log files`);

    return lines.join('\n');
  }

  /** Dispatch the infra administrator to investigate something */
  private async dispatchInfra(projectId: string, userId: string, task: string): Promise<string> {
    // Find existing infra admin for this project, or auto-hire
    const employees = await Employee.find({ userId, projectId });
    let infra: any = employees.find(e => e.role === 'infra-administrator');

    if (!infra) {
      infra = await employeeService.hire(userId, projectId, 'infra-administrator');
    }

    if (infra.status === 'working') {
      return `🏗️ ${infra.name} is already on a task. Wait for it to finish or check their logs.`;
    }

    // Dispatch the task in background
    employeeService.assignTask(userId, infra._id.toString(), task, () => {}).then(
      () => telegramService.send(`🏗️ Infra report ready: "${task.substring(0, 80)}"`).catch(() => {}),
      (err: any) => telegramService.send(`❌ Infra investigation failed: ${err.message}`).catch(() => {}),
    );

    return `🏗️ Dispatched ${infra.name} to investigate: "${task.substring(0, 100)}"`;
  }

  /**
   * Self-healing watchdog — runs every 30min.
   * Detects if the manager got stuck or stopped responding.
   * If there's an unanswered user message, uses AI to reflect and resume.
   * Also checks if the loop itself died and restarts it.
   */
  /** Employee self-check: runs at 2x loop. Detects employees who finished but forgot to call task-done */
  /** Scan .agents/status/ and .agents/task-results/ for file-based updates from employees */
  private async scanEmployeeFiles(userId: string): Promise<void> {
    const projects = await Project.find({ userId });
    const employees = await Employee.find({ userId });

    for (const project of projects) {
      const allFolders = [...(project.folders || [])];
      if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
      const cwd = allFolders[0];
      if (!cwd) continue;

      const statusDir = path.join(cwd, '.agents', 'status');
      const taskResultsDir = path.join(cwd, '.agents', 'task-results');

      // Scan status files
      if (fs.existsSync(statusDir)) {
        for (const file of fs.readdirSync(statusDir)) {
          if (!file.endsWith('.md')) continue;
          const role = file.replace('.md', '');
          const emp = employees.find(e => e.role === role && e.projectId.toString() === project._id.toString());
          if (!emp) continue;

          const filePath = path.join(statusDir, file);
          const stat = fs.statSync(filePath);
          const fileModified = stat.mtime.getTime();
          const lastKnown = emp.workingStatusAt ? new Date(emp.workingStatusAt).getTime() : 0;

          // Only process if the file is newer than what we know
          if (fileModified > lastKnown) {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content) continue;

            emp.workingStatus = content.substring(0, 5000);
            emp.workingStatusAt = stat.mtime;
            emp.workingStatusRead = false;
            emp.lastActivity = new Date();

            // Auto-detect idle
            const lower = content.toLowerCase();
            const idleSignals = ['done and idle', 'state: idle', 'state: done', 'all tasks done', 'nothing to do'];
            if (idleSignals.some(s => lower.includes(s)) && emp.status === 'working') {
              const inProgress = emp.taskHistory.filter(t => t.status === 'in_progress');
              for (const task of inProgress) {
                task.status = 'completed';
                task.completedAt = new Date();
                if (!task.result) task.result = content.substring(0, 2000);
              }
              emp.status = 'idle';
              emp.currentTask = '';
              telegramBot.send(`✅ *${emp.name}* is done (file-based status)\n📋 _${project.name}_`).catch(() => {});
              wsService.employeeStatusChanged(emp._id.toString(), project._id.toString(), 'idle', emp.name);
            }

            await emp.save();

            // Save to working status history
            const latestTask = emp.taskHistory[emp.taskHistory.length - 1];
            WorkingStatusHistory.create({
              userId: emp.userId.toString(), employeeId: emp._id.toString(), projectId: project._id.toString(),
              employeeName: emp.name, employeeRole: emp.role,
              content: content.substring(0, 5000),
              source: 'file',
              taskId: latestTask?.taskId,
            }).catch(() => {});

            wsService.employeeStatusChanged(emp._id.toString(), project._id.toString(), emp.status, emp.name);
            log('info', `File scan: ${emp.avatar} ${emp.name} status updated from ${file}`);
          }
        }
      }

      // Scan task result files
      if (fs.existsSync(taskResultsDir)) {
        for (const file of fs.readdirSync(taskResultsDir)) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(taskResultsDir, file);
          const content = fs.readFileSync(filePath, 'utf-8').trim();
          if (!content) continue;

          // Parse filename: role-taskId.md
          const match = file.match(/^(.+?)-([a-f0-9-]+)\.md$/);
          if (!match) continue;
          const [, role, taskId] = match;

          const emp = employees.find(e => e.role === role && e.projectId.toString() === project._id.toString());
          if (!emp) continue;

          const task = emp.taskHistory.find(t => t.taskId === taskId);
          if (!task) continue;

          // Update task result
          task.result = content.substring(0, 5000);
          (task as any).resultUpdatedAt = new Date();
          task.resultRead = false;
          if (task.status === 'in_progress') {
            task.status = 'completed';
            task.completedAt = new Date();
          }
          emp.lastActivity = new Date();
          await emp.save();

          // Move processed file so we don't re-read it
          const processedDir = path.join(taskResultsDir, '.processed');
          if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
          fs.renameSync(filePath, path.join(processedDir, file));

          wsService.employeeTaskUpdate(emp._id.toString(), project._id.toString(), {
            taskId: task.taskId, status: task.status, result: task.result, description: task.description,
          });
          telegramBot.send(`✅ *${emp.name}* finished: "${task.description}"\n📋 _${project.name}_`).catch(() => {});
          log('info', `File scan: ${emp.avatar} ${emp.name} task result from ${file}`);
        }
      }
    }
  }

  /** Employee self-check: runs at half Alfred's loop. Ensures employees report task results and manage their status */
  private async employeeSelfCheck(): Promise<void> {
    try {
      const user = await User.findOne().sort({ createdAt: 1 });
      if (!user) return;

      // Scan file-based status updates and task results from employees
      await this.scanEmployeeFiles(user._id.toString());

      // Check ALL employees with sessions, not just "working" ones
      const allEmps = await Employee.find({ userId: user._id });
      if (!allEmps.length) return;

      for (const emp of allEmps) {
        const sessionId = emp.currentTask || emp.activeSessionId;
        if (!sessionId) continue;

        const unreportedTasks = emp.taskHistory.filter(t => t.status === 'in_progress');
        const completedNoResult = emp.taskHistory.filter(t => t.status === 'completed' && !t.result);

        // Check if working status is missing or stale
        const wsAge = emp.workingStatusAt ? Date.now() - new Date(emp.workingStatusAt).getTime() : Infinity;
        const wsStale = !emp.workingStatus || wsAge > this.loopIntervalMs;

        // Skip only if: no pending tasks AND working status is fresh
        if (unreportedTasks.length === 0 && completedNoResult.length === 0 && !wsStale) continue;

        // Build a purpose-driven prompt
        const pendingItems: string[] = [];

        for (const t of unreportedTasks) {
          pendingItems.push(
            `🔴 IN PROGRESS — "${t.description}" (taskId: ${t.taskId})\n` +
            `   → If DONE: update your working status with "done" or "idle" in the text.\n` +
            `   → If NOT DONE: update your working status describing what you're doing.`
          );
        }

        for (const t of completedNoResult) {
          pendingItems.push(
            `⚠️ COMPLETED BUT NO OUTPUT — "${t.description}" (taskId: ${t.taskId})\n` +
            `   → Update your working status describing what you did.`
          );
        }

        const allTasksDone = unreportedTasks.length === 0;
        const idleReminder = allTasksDone && emp.status === 'working'
          ? `\n\nALL TASKS DONE — update your working status with "idle" or "done" in the text to auto-complete.`
          : '';

        const lastWS = emp.workingStatus
          ? `\nYour last working status (${emp.workingStatusAt ? new Date(emp.workingStatusAt).toLocaleTimeString() : 'unknown'}): "${emp.workingStatus.substring(0, 200)}"`
          : '\nYou have NOT updated your working status yet. Do it now.';

        const prompt = `[SELF-CHECK LOOP — ${emp.title}]

You are ${emp.name}, ${emp.title}. This is your periodic self-check.

FIRST — UPDATE YOUR WORKING STATUS RIGHT NOW:
This is your #1 priority. Use the Write tool to write your status to this file IMMEDIATELY:

File: .agents/status/${emp.role}.md

Write a detailed markdown status with these sections: Task, Progress (✅/⬜), Files Changed, Current, State (working/done/stuck).
Include "done and idle" in State when finished — the system reads this file automatically.

${lastWS}

${pendingItems.length > 0 ? `YOUR PENDING ITEMS (${pendingItems.length}):\n${pendingItems.join('\n\n')}` : 'No pending items.'}
${idleReminder}

RULES:
- UPDATE WORKING STATUS FIRST — before anything else.
- Include "done" or "idle" in your status text when finished — this auto-completes your tasks.
- Use markdown format: ## headers, ✅/⬜ checkboxes, \`code\`, tables.
- Alfred reads your working status to know what's happening. No status = Alfred doesn't know.`;

        claudeCodeService.injectMessage(sessionId, prompt);
        log('info', `Employee self-check: ${emp.avatar} ${emp.name} — ${unreportedTasks.length} in_progress, ${completedNoResult.length} no-result`);
      }
    } catch (err: any) {
      log('error', `Employee self-check failed: ${err.message}`);
    }
  }

  /**
   * Fast activity check — runs every 5 minutes.
   * Detects employees who have been working but silent (no log output).
   * Phase 1 (first check):  Nudge — ask for status update.
   * Phase 2 (second check): Urgent warning — will restart next time.
   * Phase 3 (third check):  Auto-restart session and re-assign the same task.
   * Uses ZERO AI tokens — pure DB queries + session injection.
   */
  private async employeeActivityCheck(): Promise<void> {
    try {
      const user = await User.findOne().sort({ createdAt: 1 });
      if (!user) return;
      const userId = user._id.toString();

      const employees = await Employee.find({ userId, status: 'working' });
      if (!employees.length) {
        this.activityNudgeCount.clear();
        return;
      }

      const now = new Date();
      const projects = await Project.find({ userId }).lean();

      for (const emp of employees) {
        const empId = emp._id.toString();
        const latestTask = [...emp.taskHistory].reverse().find(t => t.status === 'in_progress');
        if (!latestTask) continue;

        // Only check if task has been running > 5 min
        const taskAge = now.getTime() - new Date(latestTask.startedAt).getTime();
        if (taskAge < this.ACTIVITY_CHECK_MS) continue;

        // ── Session alive = employee is working. Skip entirely. ──
        // Use activeSessionId (the actual key in activeSessions), NOT currentTask (which is a different UUID).
        const sessionId = emp.activeSessionId || emp.currentTask;
        if (sessionId && claudeCodeService.isSessionAlive(sessionId)) {
          this.activityNudgeCount.delete(empId);
          continue;
        }

        // ── Session is dead but employee still marked "working" — check logs ──
        const lastLog = await EmployeeLog.findOne({
          userId, employeeId: empId,
          'metadata.alfredGenerated': { $ne: true },
        }).sort({ createdAt: -1 }).select('createdAt category content').lean();

        const lastLogAt = lastLog?.createdAt ? new Date(lastLog.createdAt).getTime() : 0;
        const lastStatusAt = emp.workingStatusAt ? new Date(emp.workingStatusAt).getTime() : 0;
        const lastActivityAt = emp.lastActivity ? new Date(emp.lastActivity).getTime() : 0;

        // Most recent sign of life: log output OR working status update
        const lastAliveAt = Math.max(lastLogAt, lastStatusAt, lastActivityAt, new Date(emp.hiredAt).getTime());
        const silentMs = now.getTime() - lastAliveAt;

        // Recent logs exist — employee's session may have just ended, give it time
        if (silentMs < this.ACTIVITY_CHECK_MS) {
          this.activityNudgeCount.delete(empId);
          continue;
        }

        // Skip employees currently doing self-evaluation (just restarted) — 15 min grace
        if (latestTask.description.startsWith('[RESTART — SELF-EVALUATION]')) {
          if (silentMs < ManagerService.NUDGE_AFTER_MS * 1.5) {
            this.activityNudgeCount.delete(empId);
            continue;
          }
        }

        const project = projects.find(p => p._id.toString() === emp.projectId.toString());
        const pName = project?.name || 'Unknown';
        const silentMin = Math.round(silentMs / 60000);
        const lastWS = emp.workingStatus ? `\nLast working status: "${emp.workingStatus.substring(0, 150)}"` : '';
        const taskDesc = latestTask.description.substring(0, 120);

        // Use absolute time thresholds for escalation (not nudge count)
        if (silentMs >= ManagerService.RESTART_AFTER_MS) {
          // ── Phase 3: Set idle + notify Bruce — 30+ min unresponsive ──
          // Do NOT auto-restart. Bruce decides when to restart from the HR panel.
          log('warning', `⏸️ ${emp.avatar} ${emp.name} unresponsive ${silentMin}min — setting idle`);

          try {
            // Kill session if alive
            if (sessionId) claudeCodeService.cancelSession(sessionId);

            emp.status = 'idle';
            emp.currentTask = '';
            emp.activeSessionId = '';
            emp.lastActivity = new Date();
            if (latestTask) {
              latestTask.status = 'failed';
              latestTask.result = `Session timed out — unresponsive for ${silentMin}min`;
              latestTask.completedAt = new Date();
            }
            await emp.save();
            wsService.employeeStatusChanged(empId, emp.projectId.toString(), 'idle', emp.name);

            appendDailyLog(
              `⏸️ ${emp.name} on ${pName} — silent ${silentMin}min, set to idle. Task: "${taskDesc}"${lastWS}`
            );

            telegramService.send(
              `⏸️ *${emp.name}* on _${pName}_ — unresponsive ${silentMin}min.${lastWS}\n` +
              `Set to idle. Task was: "${taskDesc}"\nRestart manually from HR if needed.`
            ).catch(() => {});

            EmployeeLog.create({
              userId, employeeId: empId, projectId: emp.projectId.toString(),
              category: 'text', content: `⏸️ Set idle — unresponsive ${silentMin}min. No auto-restart.${lastWS}`,
              employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role, projectName: pName,
              metadata: { alfredGenerated: true },
            }).catch(() => {});
          } catch (err: any) {
            log('error', `Failed to idle ${emp.name}: ${err.message}`);
          }

          this.activityNudgeCount.delete(empId);

        } else if (silentMs >= ManagerService.WARN_AFTER_MS && (this.activityNudgeCount.get(empId) || 0) < 2) {
          // ── Phase 2: Urgent warning — 20+ min silent ──
          log('warning', `⚠️ ${emp.avatar} ${emp.name} silent ${silentMin}min — urgent warning`);

          if (sessionId) {
            claudeCodeService.injectMessage(sessionId,
              `[URGENT from Alfred] No status update for ${silentMin} minutes.\n` +
              `Your task: "${taskDesc}"\n\n` +
              `You MUST update your working status NOW:\n` +
              `- If DONE: write "State: done and idle"\n` +
              `- If WORKING: describe progress\n` +
              `- If you don't respond within 10 more minutes, your session will be RESTARTED.`
            );
          }

          telegramService.send(
            `⚠️ *${emp.name}* on _${pName}_ — no status for ${silentMin}min.${lastWS}\n` +
            `Task: "${taskDesc}"\nWill restart if still silent at 30min.`
          ).catch(() => {});

          EmployeeLog.create({
            userId, employeeId: empId, projectId: emp.projectId.toString(),
            category: 'text', content: `⚠️ Urgent: silent ${silentMin}min — warned about restart${lastWS}`,
            employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role, projectName: pName,
            metadata: { alfredGenerated: true },
          }).catch(() => {});

          this.activityNudgeCount.set(empId, 2);

        } else if (silentMs >= ManagerService.NUDGE_AFTER_MS && (this.activityNudgeCount.get(empId) || 0) < 1) {
          // ── Phase 1: First nudge — 10+ min silent ──
          log('warning', `⏰ ${emp.avatar} ${emp.name} silent ${silentMin}min — nudge`);

          if (sessionId) {
            claudeCodeService.injectMessage(sessionId,
              `[ACTIVITY CHECK from Alfred] You've been silent for ${silentMin} minutes.\n` +
              `Your task: "${taskDesc}"\n\n` +
              `Please update your working status:\n` +
              `1. FINISHED? → Write "State: done and idle" to .agents/status/${emp.role}.md\n` +
              `2. Still WORKING? → Write progress with files changed\n` +
              `3. STUCK? → Describe the blocker`
            );
          }

          EmployeeLog.create({
            userId, employeeId: empId, projectId: emp.projectId.toString(),
            category: 'text', content: `⏰ Activity nudge: silent ${silentMin}min${lastWS}`,
            employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role, projectName: pName,
            metadata: { alfredGenerated: true },
          }).catch(() => {});

          this.activityNudgeCount.set(empId, 1);
        }
      }

      // Clean up tracking for employees no longer working
      for (const empId of this.activityNudgeCount.keys()) {
        if (!employees.find(e => e._id.toString() === empId)) {
          this.activityNudgeCount.delete(empId);
        }
      }
    } catch (err: any) {
      log('error', `Employee activity check failed: ${err.message}`);
    }
  }

  private async selfHeal(): Promise<void> {
    try {
      // ── 1. Ensure the fast loop is still running ──
      if (!this.interval) {
        log('warning', 'Watchdog: fast loop was dead — restarting');
        persistLog('watchdog', 'Fast loop was dead — restarted');
        this.interval = setInterval(() => this.runCheck().catch(() => {}), 15 * 60 * 1000);
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

      if (hasUnanswered && unansweredAgeMs > 15 * 60 * 1000) {
        const ageMin = (unansweredAgeMs / 60000).toFixed(0);
        log('warning', `Watchdog: unanswered message from ${ageMin}min ago — recovering`);
        persistLog('watchdog', `Unanswered message detected (${ageMin}min old): "${lastMsg.content.substring(0, 100)}" — recovering`, { userId });

        telegramService.send(`🔄 _Sorry Bruce — I got hung up on your last message. Picking it back up now._`).catch(() => {});

        try {
          persistLog('ai_call', 'Watchdog recovery: calling AI', { userId });
          const context = await this.buildContext(userId, lastMsg.content);
          const msgHistory = history.slice(-MAX_HISTORY).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
          const startTime = Date.now();
          const response = await this.callAI(context, msgHistory, userId);
          const elapsed = Date.now() - startTime;
          this.lastResponseAt = Date.now();
          persistLog('ai_call', `Watchdog recovery: AI responded in ${(elapsed / 1000).toFixed(1)}s`, { userId, metadata: { durationMs: elapsed } });

          const { cleanResponse, actions } = this.parseActions(response);
          const actionResults: string[] = [];
          for (const action of actions) {
            if (this.isDuplicateAction(action)) {
              log('warning', `Dedup: skipping duplicate watchdog ${action.action}`);
              actionResults.push(`⏭️ Skipped duplicate: ${action.action}`);
              continue;
            }
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

      // ── 2b. End-of-day memory summarization ──
      const watchdogNow = new Date();
      const currentHour = watchdogNow.getHours();
      if (currentHour === 23 && !this.dailySummaryDone) {
        this.dailySummaryDone = true;
        log('info', 'Watchdog: creating end-of-day memory summary');
        persistLog('watchdog', 'Creating daily memory summary', { userId });
        try {
          const todayLogContent = readMemoryFile(getTodayLogPath());
          if (todayLogContent.length > 100) {
            const mem = await memoryService.createDailySummary(userId, todayLogContent, watchdogNow);
            if (mem) {
              log('info', 'Watchdog: daily memory summary saved');
              persistLog('watchdog', 'Daily memory summary saved', { userId });
              appendDailyLog('🧠 End-of-day memory summary created and embedded');

              // On Sundays, also create weekly rollup
              if (watchdogNow.getDay() === 0) {
                const weekStart = new Date(watchdogNow);
                weekStart.setDate(weekStart.getDate() - 6);
                weekStart.setHours(0, 0, 0, 0);
                const weekMem = await memoryService.createWeeklySummary(userId, weekStart);
                if (weekMem) {
                  log('info', 'Watchdog: weekly memory rollup saved');
                  appendDailyLog('🧠 Weekly memory rollup created');
                }
              }
            }
          }
        } catch (err: any) {
          log('error', `Watchdog: daily summary failed: ${err.message}`);
        }
      }
      // Reset daily flag at midnight
      if (currentHour === 0) this.dailySummaryDone = false;

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

      // ── 3. Stuck employee detection based on LAST LOG activity ──
      // NOTE: The fast 5-min activityCheck handles short-term silence (nudge → warn → restart).
      // This section handles longer-term stuck detection (stuckNudgeMs, typically hours).
      // Skip employees already being tracked by the fast activity check to avoid double-nudging.
      const SILENT_NUDGE_MS = this.stuckNudgeMs;
      const SILENT_RESTART_MS = this.stuckRestartMs;

      // Batch-fetch the latest REAL log timestamp per working employee
      // Excludes Alfred-generated logs (nudges, system messages) so they don't mask a stuck agent
      const workingEmps = employees.filter(e => e.status === 'working' && !this.activityNudgeCount.has(e._id.toString()));
      const lastLogTimes = new Map<string, Date>();
      for (const emp of workingEmps) {
        const lastLog = await EmployeeLog.findOne({
          userId, employeeId: emp._id.toString(),
          'metadata.alfredGenerated': { $ne: true },
        }).sort({ createdAt: -1 }).select('createdAt').lean();
        lastLogTimes.set(emp._id.toString(), lastLog?.createdAt || emp.lastActivity || emp.hiredAt);
      }

      for (const emp of employees) {
        if (emp.status !== 'working') {
          snap.nudgedEmployees.delete(emp._id.toString());
          continue;
        }

        const empId = emp._id.toString();
        const lastLogAt = lastLogTimes.get(empId) || emp.lastActivity || emp.hiredAt;
        const silentMs = now.getTime() - new Date(lastLogAt).getTime();
        const project = projects.find(p => p._id.toString() === emp.projectId.toString());
        const pName = project?.name || 'Unknown';

        // Phase 1: Silent > 5min since last log — nudge
        if (silentMs > SILENT_NUDGE_MS && !snap.nudgedEmployees.has(empId)) {
          log('warning', `${emp.avatar} ${emp.name} silent for ${Math.round(silentMs / 60000)}min — nudging`);
          snap.nudgedEmployees.set(empId, Date.now());

          if (emp.currentTask) {
            const nudgeMsg = `[SYSTEM CHECK from Alfred] No activity detected for ${Math.round(silentMs / 60000)} minutes. Are you stuck? If you're making progress, produce some output (read a file, run a command, anything). If blocked, write to .agents/inbox/. If done, write your execution log and finish up.`;
            claudeCodeService.injectMessage(emp.currentTask, nudgeMsg);
            EmployeeLog.create({
              userId, employeeId: empId, projectId: emp.projectId.toString(),
              category: 'text', content: `📩 Alfred nudged: no logs for ${Math.round(silentMs / 60000)}min`,
              employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role, projectName: pName,
              metadata: { alfredGenerated: true },
            }).catch(() => {});
          }

          notifications.push(`⏰ *${emp.name}* silent ${Math.round(silentMs / 60000)}min on _${pName}_ — sent check-in`);
        }

        // Phase 2: Still silent after nudge — send stronger message, notify Bruce (do NOT kill session)
        const nudgedAt = snap.nudgedEmployees.get(empId);
        if (nudgedAt && silentMs > SILENT_RESTART_MS && (Date.now() - nudgedAt) > 5 * 60 * 1000) {
          log('warning', `${emp.avatar} ${emp.name} unresponsive after nudge — notifying Bruce`);
          snap.nudgedEmployees.delete(empId);

          // Send a stronger message but keep the session alive
          const sessionToNudge = emp.currentTask || emp.activeSessionId;
          if (sessionToNudge) {
            claudeCodeService.injectMessage(sessionToNudge, `[URGENT from Alfred] You have been unresponsive for ${Math.round(silentMs / 60000)} minutes. Produce output NOW or write to .agents/inbox/ explaining what's happening.`);
          }

          const lastTask = emp.taskHistory[emp.taskHistory.length - 1];
          const taskDesc = lastTask?.description || '';
          emp.lastActivity = now;
          await emp.save();

          EmployeeLog.create({
            userId, employeeId: empId, projectId: emp.projectId.toString(),
            category: 'text', content: `⚠️ Unresponsive after nudge — Bruce notified`,
            employeeName: emp.name, employeeAvatar: emp.avatar, employeeRole: emp.role, projectName: pName,
            metadata: { alfredGenerated: true },
          }).catch(() => {});

          notifications.push(`⚠️ *${emp.name}* unresponsive on _${pName}_ for ${Math.round(silentMs / 60000)}min — "${taskDesc.substring(0, 60)}"\nReply with "restart ${emp.name}" if you want me to restart them.`);
          appendDailyLog(`⚠️ ${emp.name} unresponsive on "${taskDesc.substring(0, 80)}" — notified Bruce`);
        }
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
        for (const n of notifications) {
          appendDailyLog(`📢 ${n.replace(/\*/g, '').replace(/_/g, '').substring(0, 150)}`);
        }
        this.lastNotificationAt = Date.now();
      }

      // ── 5b. Process urgent inbox messages (no AI — just forward to Bruce) ──
      const urgentInbox = await ManagerInbox.find({
        userId, read: false, type: { $in: ['issue', 'question'] },
      }).sort({ createdAt: 1 }).limit(5).lean();

      if (urgentInbox.length > 0) {
        const inboxNotifs: string[] = [];
        for (const m of urgentInbox) {
          const typeIcon = m.type === 'issue' ? '🚨' : '❓';
          inboxNotifs.push(
            `${typeIcon} *${m.employeeAvatar} ${m.employeeName}* (${m.projectName}): ${m.subject}`
          );
          appendDailyLog(`📨 Forwarded ${m.type} from ${m.employeeName}: ${m.subject}`);
        }
        const inboxMsg = `📨 *Employee Messages*\n\n${inboxNotifs.join('\n\n')}`;
        telegramService.send(inboxMsg).catch(() => {});
        log('info', `Loop: forwarded ${urgentInbox.length} urgent inbox message(s) to Bruce`);
        persistLog('loop', `Forwarded ${urgentInbox.length} urgent inbox messages`, { userId });

        // Mark as read after forwarding
        await ManagerInbox.updateMany(
          { _id: { $in: urgentInbox.map(m => m._id) } },
          { read: true, processedAt: new Date() },
        );
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
            const context = await this.buildContext(userId, lastMsg.content);
            const msgHistory = history.slice(-MAX_HISTORY).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
            const READ_ACTIONS_RECOVERY = new Set(['read_employee_status', 'read_employee_status_history', 'read_task_results', 'ask_employee', 'read_direction', 'recall_memory']);
            let recoveryResponse = await this.callAI(context, msgHistory, userId);
            this.lastResponseAt = Date.now();

            let recoveryClean = '';
            const recoveryResults: string[] = [];

            for (let turn = 0; turn <= 3; turn++) {
              const { cleanResponse, actions } = this.parseActions(recoveryResponse);
              if (turn === 0) recoveryClean = cleanResponse;
              else if (cleanResponse) recoveryClean = cleanResponse;

              if (actions.length === 0) break;

              const readResults: string[] = [];
              for (const action of actions) {
                if (this.isDuplicateAction(action)) {
                  log('warning', `Dedup: skipping duplicate recovery ${action.action}`);
                  recoveryResults.push(`⏭️ Skipped duplicate: ${action.action}`);
                  continue;
                }
                try {
                  const result = await this.executeAction(action, userId);
                  recoveryResults.push(`✅ ${result}`);
                  if (READ_ACTIONS_RECOVERY.has(action.action)) {
                    readResults.push(`[${action.action}]: ${result}`);
                  }
                } catch (err: any) {
                  recoveryResults.push(`❌ ${err.message}`);
                }
              }

              if (readResults.length > 0 && turn < 3) {
                log('info', `Recovery follow-up turn ${turn + 1}: feeding ${readResults.length} read results`);
                const followUp = `Here are the results:\n\n${readResults.join('\n\n')}\n\nAnalyze and respond to Bruce NOW. Include further actions if needed.`;
                msgHistory.push({ role: 'assistant', content: recoveryResponse });
                msgHistory.push({ role: 'user', content: followUp });
                recoveryResponse = await this.callAI(context, msgHistory, userId);
                this.lastResponseAt = Date.now();
                continue;
              }
              break;
            }

            let finalResponse = recoveryClean;
            if (recoveryResults.length) finalResponse += '\n\n' + recoveryResults.join('\n');
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

      // ── 7. Proactive AI thinking — scan for issues & opportunities ──
      // Conditions that trigger proactive AI analysis:
      const idleEmployees = employees.filter(e => {
        if (e.status !== 'idle') return false;
        const proj = projects.find(p => p._id.toString() === e.projectId.toString());
        if (!proj || proj.onHolding) return false; // skip on-holding companies
        const folders = [...(proj?.folders || [])];
        if (proj?.localPath && !folders.includes(proj.localPath)) folders.unshift(proj.localPath);
        return folders.length > 0;
      });
      const workingNow = employees.filter(e => e.status === 'working');
      const hasFailedRecently = notifications.some(n => n.includes('❌') || n.includes('failed'));
      const hasIdleWorkers = idleEmployees.length > 0;
      const nobodyWorking = workingNow.length === 0 && employees.length > 0;

      // Trigger proactive thinking when there's something to act on
      if (hasIdleWorkers || hasFailedRecently || nobodyWorking) {
        try {
          log('info', 'Loop: proactive AI thinking triggered');
          persistLog('loop', `Proactive scan: ${idleEmployees.length} idle, ${workingNow.length} working, failures: ${hasFailedRecently}`, { userId });

          this.scanCount++;

          // Build strategic context from DB (async)
          const strategicCtx = await this.buildStrategicCheckContext(projects, idleEmployees);

          // Compute unread task results + check who needs attention
          const unreadByEmployee: string[] = [];
          const upToDateEmployees: string[] = [];
          const needsAttention: string[] = [];

          for (const emp of employees) {
            // Check unread task results
            const unreadTasks = emp.taskHistory.filter((t: any) => !t.resultRead && t.result);
            if (unreadTasks.length > 0) {
              unreadByEmployee.push(`  🔴 ${emp.avatar} ${emp.name}: ${unreadTasks.length} unread task result(s) — read_task_results unread:true (auto-marks as read)`);
            }

            // Check unread working status
            if (emp.workingStatus && !emp.workingStatusRead) {
              unreadByEmployee.push(`  🔴 ${emp.avatar} ${emp.name}: unread working status — read_employee_status`);
            }

            // Timestamp check (millisecond precision): has the employee reported since last assignment?
            const lastAssignedMs = emp.lastAssignedAt ? new Date(emp.lastAssignedAt).getTime() : 0;
            const statusUpdatedMs = emp.workingStatusAt ? new Date(emp.workingStatusAt).getTime() : 0;
            const latestTaskResultMs = emp.taskHistory.reduce((max: number, t: any) => {
              const ms = t.resultUpdatedAt ? new Date(t.resultUpdatedAt).getTime() : 0;
              return ms > max ? ms : max;
            }, 0);
            const latestReportMs = Math.max(statusUpdatedMs, latestTaskResultMs);

            const hasUnread = unreadTasks.length > 0 || (emp.workingStatus && !emp.workingStatusRead);

            if (lastAssignedMs > 0 && latestReportMs > lastAssignedMs && !hasUnread) {
              // Reported AFTER assignment AND Alfred already read it — fully up to date
              const agoMin = Math.round((Date.now() - latestReportMs) / 60000);
              upToDateEmployees.push(`  ✅ ${emp.avatar} ${emp.name}: up to date (reported ${agoMin}min ago, already read)`);
            } else if (lastAssignedMs > 0 && latestReportMs > lastAssignedMs && hasUnread) {
              // Reported but Alfred hasn't read yet — just needs reading, not asking
              upToDateEmployees.push(`  📖 ${emp.avatar} ${emp.name}: reported but unread — read it, don't ask them`);
            } else if (lastAssignedMs > 0 && latestReportMs <= lastAssignedMs && emp.status === 'working') {
              // NOT reported since assignment — may need a nudge
              const sinceMins = Math.round((Date.now() - lastAssignedMs) / 60000);
              needsAttention.push(`  ⏳ ${emp.avatar} ${emp.name}: assigned ${sinceMins}min ago, no report yet`);
            }
          }

          const unreadSection = unreadByEmployee.length > 0
            ? `\nUNREAD TASK RESULTS (read these FIRST):\n${unreadByEmployee.join('\n')}\n`
            : '';
          const attentionSection = needsAttention.length > 0
            ? `\nNEEDS ATTENTION (no report since last assignment):\n${needsAttention.join('\n')}\n`
            : '';
          const upToDateSection = upToDateEmployees.length > 0
            ? `\nUP TO DATE (already reported — do NOT ask them again):\n${upToDateEmployees.join('\n')}\n`
            : '';

          // Build a focused prompt for the proactive scan (with memory context)
          const memoryQuery = `proactive scan: ${idleEmployees.length} idle, ${workingNow.length} working, failures: ${hasFailedRecently}`;
          const context = await this.buildContext(userId, memoryQuery);
          // Compute pending work across all employees
          const pendingTasks = employees.reduce((n: number, e: any) => n + e.taskHistory.filter((t: any) => t.status === 'in_progress').length, 0);
          const failedTasks = employees.reduce((n: number, e: any) => n + e.taskHistory.filter((t: any) => t.status === 'failed' && !t.resultRead).length, 0);

          // Companies without strategic direction OR with stale direction
          const noDirection = projects.filter(p => !p.onHolding && (!p.strategicDirection || !p.strategicDirection.trim()) && (!p.strategicCycle || p.strategicCycle.status === 'idle'));
          const noDirectionSection = noDirection.length > 0
            ? `\n⚠️ COMPANIES WITHOUT DIRECTION (${noDirection.length}):\n${noDirection.map(p => {
                const ceo = employees.find(e => e.projectId.toString() === p._id.toString() && e.role === 'ceo');
                return `  - ${p.name} (ID: ${p._id}) — no strategic plan.${ceo ? ` Has CEO: ${ceo.avatar} ${ceo.name} (${ceo._id}) — ASSIGN them a direction task.` : ' No CEO hired. Suggest to Bruce: hire a CEO or set direction manually.'}`;
              }).join('\n')}\n`
            : '';

          // Companies with direction but stale (employees active, direction not updated in 7+ days)
          const staleDirectionCompanies = projects.filter(p => {
            if (p.onHolding || !p.strategicDirection) return false;
            const pEmps = employees.filter(e => e.projectId.toString() === p._id.toString());
            const hasActivity = pEmps.some(e => e.status === 'working' || (e.workingStatusAt && (now.getTime() - new Date(e.workingStatusAt).getTime()) < 24 * 60 * 60 * 1000));
            if (!hasActivity) return false;
            // No cycle active or cycle done — direction might need refresh
            const cycleStatus = p.strategicCycle?.status || 'idle';
            return ['idle', 'done'].includes(cycleStatus);
          });
          const staleDirectionSection = staleDirectionCompanies.length > 0
            ? `\n🔄 COMPANIES WITH ACTIVITY BUT NO ACTIVE CYCLE (${staleDirectionCompanies.length}):\n${staleDirectionCompanies.map(p => {
                const ceo = employees.find(e => e.projectId.toString() === p._id.toString() && e.role === 'ceo');
                const idleCeo = ceo && ceo.status === 'idle';
                return `  - ${p.name} (ID: ${p._id}) — employees active but cycle is ${p.strategicCycle?.status || 'idle'}.${idleCeo ? ` CEO ${ceo!.avatar} ${ceo!.name} (${ceo!._id}) is IDLE — assign them to review direction and set new priorities.` : ceo ? ` CEO is working.` : ' No CEO.'}`;
              }).join('\n')}\n`
            : '';

          const scanPrompt = `[PROACTIVE SCAN — this is your loop, NOT a message from Bruce]

You are running your regular patrol. Focus on PENDING WORK — we lose money with unresolved pendencies AND with companies that have no leadership direction.
REMINDER: You get ONE response. Include ALL your manager-action blocks NOW. Do not say "I'll check" — just include the action. Do NOT use hands_on or read_file to inspect employee work — use read_employee_status and read_task_results instead.

PENDING WORK:
- Unread items: ${unreadByEmployee.length > 0 ? unreadByEmployee.length + ' unread (statuses + task results)' : 'None — all read'}
- Tasks in progress: ${pendingTasks}
- Unread failures: ${failedTasks}
- Employees needing attention: ${needsAttention.length || 'None'}
- Companies without direction: ${noDirection.length > 0 ? noDirection.length : 'None'}
- Companies needing direction refresh: ${staleDirectionCompanies.length || 'None'}
${unreadSection}${attentionSection}${upToDateSection}${noDirectionSection}${staleDirectionSection}${notifications.length > 0 ? `\nNOTIFICATIONS THIS TICK:\n${notifications.join('\n')}` : ''}

YOUR PRIORITIES (follow this order STRICTLY):

STEP 1 — READ WORKING STATUS (your #1 source of truth):
  For each employee with 🔴 markers above:
  a. If unread WORKING STATUS → read_employee_status (this auto-marks it as read)
     The working status is a detailed markdown report written by the employee. It tells you:
     - What they did (files changed, features built)
     - What's running (ports, services)
     - What's blocked (errors, dependencies)
     - Whether they're done or still working
     This is ALL you need to make decisions. Do NOT go read their code or log files.
  b. If unread TASK RESULTS → read_task_results with unread:true (auto-marks as read)
  Do ALL reads FIRST before any other action. This is how you learn what happened.

STEP 2 — DECIDE (based on working status, NOT code analysis):
  Based on what you read in their status reports:
  - Status says "done" / all checkmarks → assign the SAME developer to test it with Playwright (they have built-in QA)
  - Testing reports bugs → same developer fixes them
  - Status reports a blocker → use read_employee_status_history to check if it's recurring, then decide: nudge, restart, or escalate
  - Task failed → read status history to understand the pattern, reassign with clearer instructions
  - New app mentioned in status → register with add_application
  - Employee restarted → use read_employee_status_history to give them context on what they were doing before
  **DO NOT use hands_on, read_file, or list_files to verify employee work. Trust the status reports.**

STEP 3 — ONLY ASK IF NEEDED:
  Do NOT ask_employee or message_employee unless:
  - The employee is in "NEEDS ATTENTION" (no report since assignment)
  - You read their status/results and they are UNCLEAR
  If an employee is "UP TO DATE" or "reported but unread" → READ first, don't ask.

STEP 4 — DIRECTION (ONLY when Bruce asks):
  Do NOT proactively assign CEOs to set or review direction. Only do this when Bruce explicitly asks.
  If Bruce asks about direction, THEN check if a CEO exists and assign them.
  If no CEO is hired and Bruce asks → suggest: "Company X has no CEO. Hire one or set direction manually."

STEP 5 — LOG & REPORT:
  Write to daily log. Only message Bruce about decisions that need him.
  ALWAYS summarize — never dump raw data. Examples:
  GOOD: "Sarah finished the API, assigned Carlos for QA. Amigo moving forward."
  BAD: "Sarah's working status says: ## Progress - ✅ Created src/api/... [200 lines of raw status]"
  If Bruce asks for details, then give a thorough breakdown. Otherwise: short summaries only.

AUTONOMOUS LOOP: developer completes a feature → assign the SAME developer to test it with Playwright (they have built-in QA capabilities). If bugs found → same developer fixes them → re-tests. You run this loop WITHOUT asking. Just inform Bruce of outcomes.
IMPORTANT: Always assign testing tasks to the SAME developer who built the feature. Do NOT use separate QA testers.

EMPLOYEE SESSION RULES (CRITICAL):
- Employees stay ALIVE after completing a task. They go to "idle" but their session persists.
- To give an idle employee a new task, just use the "task" action — it sends a message to their existing session.
- You can NEVER stop an employee. Only Bruce can stop them.
- If an employee appears stuck, send them a message (message_employee) — do NOT stop or restart them.
- If you believe an employee needs to be stopped or restarted, ASK BRUCE on Telegram first: "Bruce, should I restart [employee name]?"
- Only after Bruce confirms, use the restart action.

APPLICATION REGISTRY (your responsibility — keep it up to date):
- When a developer finishes building an app, ASK THEM (ask_employee) to find the port, service name, and type.
- IMMEDIATELY register it with add_application (name, port, type, dockerService, purpose, description).
- After QA tests an app, update it with update_application: set tested=true if it passed, tested=false if bugs were found.
- **TEST INSTRUCTIONS**: Every application MUST have testInstructions. After QA finishes testing an app, read their exec log and extract the test steps/instructions they used (or should be used). Then update_application with testInstructions containing clear, step-by-step testing instructions. If an app has NO test instructions (shown as "⚠️ NO test instructions" in context), proactively assign a QA Tester to test it and document the test instructions. Bruce checks test instructions in the Applications Registry — keep them thorough and up to date.
- After QA runs, collect their screenshots with collect_screenshots so Bruce can see them in the Applications Registry.
- When an app's docker container is started/stopped, update its status accordingly.
- Keep the purpose field meaningful — it explains WHY the app exists, not WHAT it does technically.
- The Applications Registry is Bruce's dashboard to see all running services. Keep it accurate.

8. If any application has NO test instructions, assign a QA Tester to test it and document the test steps via update_application testInstructions.

${strategicCtx ? `STRATEGIC ACTION NEEDED:\n${strategicCtx}` : ''}

If everything is genuinely fine and there's nothing actionable, just write to your daily log and say nothing on Telegram.`;

          const READ_ACTIONS_PROACTIVE = new Set(['read_employee_status', 'read_employee_status_history', 'read_task_results', 'ask_employee', 'read_direction', 'recall_memory']);
          const proactiveHistory: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: scanPrompt }];
          let proactiveResponse = await this.callAI(context, proactiveHistory, userId);
          this.lastResponseAt = Date.now();

          let finalCleanProactive = '';
          const allProactiveResults: string[] = [];

          for (let turn = 0; turn <= 3; turn++) {
            const { cleanResponse, actions } = this.parseActions(proactiveResponse);
            if (turn === 0) finalCleanProactive = cleanResponse;
            else if (cleanResponse) finalCleanProactive = cleanResponse;

            if (actions.length === 0) break;

            const readResults: string[] = [];
            for (const action of actions) {
              if (this.isDuplicateAction(action)) {
                log('warning', `Dedup: skipping duplicate proactive ${action.action}`);
                allProactiveResults.push(`⏭️ Skipped duplicate: ${action.action}`);
                continue;
              }
              try {
                const result = await this.executeAction(action, userId);
                allProactiveResults.push(`✅ ${result}`);
                appendDailyLog(`⚡ Proactive: ${action.action} → ${result.substring(0, 150)}`);
                if (READ_ACTIONS_PROACTIVE.has(action.action)) {
                  readResults.push(`[${action.action}]: ${result}`);
                }
              } catch (err: any) {
                allProactiveResults.push(`❌ ${err.message}`);
              }
            }

            if (readResults.length > 0 && turn < 3) {
              log('info', `Proactive follow-up turn ${turn + 1}: feeding ${readResults.length} read results`);
              const followUp = `Here are the results of your actions:\n\n${readResults.join('\n\n')}\n\nAnalyze these and decide what to do next. Include actions NOW. One more turn.`;
              proactiveHistory.push({ role: 'assistant', content: proactiveResponse });
              proactiveHistory.push({ role: 'user', content: followUp });
              proactiveResponse = await this.callAI(context, proactiveHistory, userId);
              this.lastResponseAt = Date.now();
              continue;
            }
            break;
          }

          let finalResponse = finalCleanProactive;
          if (allProactiveResults.length) {
            if (this.commMode === 'verbose') {
              finalResponse += '\n\n' + allProactiveResults.join('\n');
            } else {
              const actionSummary = allProactiveResults.map(r => r.substring(0, 80)).join('\n');
              if (actionSummary) finalResponse += '\n\n' + actionSummary;
            }
          }

          // Only send to Telegram if Alfred actually has something to say
          if (finalResponse.trim() && !finalResponse.toLowerCase().includes('nothing to report')) {
            telegramService.send(finalResponse).catch(() => {});
            appendDailyLog(`🧠 Proactive: ${finalResponse.substring(0, 200)}`);
            persistLog('loop', `Proactive response: ${finalResponse.substring(0, 150)}`, { userId });
          } else {
            appendDailyLog('🧠 Proactive scan: all clear, nothing actionable');
          }

          log('info', 'Loop: proactive scan complete');
        } catch (err: any) {
          log('error', `Loop proactive scan failed: ${err.message}`);
          persistLog('error', `Proactive scan failed: ${err.message}`, { userId });
        }
      }

      // ── 8. Prune old reported IDs to prevent memory leak ──
      if (snap.reportedCompleted.size > 500) {
        const arr = Array.from(snap.reportedCompleted);
        snap.reportedCompleted = new Set(arr.slice(-200));
      }
      if (snap.reportedFailed.size > 500) {
        const arr = Array.from(snap.reportedFailed);
        snap.reportedFailed = new Set(arr.slice(-200));
      }

      // ── 9. Backoff: if Alfred notified Bruce but got no response, slow down ──
      if (this.lastNotificationAt > 0 && this.lastUserMsgAt < this.lastNotificationAt) {
        // Bruce hasn't replied since last notification — back off
        const maxInterval = this.baseLoopIntervalMs * Math.pow(ManagerService.BACKOFF_FACTOR, ManagerService.MAX_BACKOFF_LOOPS);
        if (this.loopIntervalMs < maxInterval) {
          const newInterval = Math.min(this.loopIntervalMs * ManagerService.BACKOFF_FACTOR, maxInterval);
          this.loopIntervalMs = Math.round(newInterval);
          log('info', `Loop backoff: Bruce silent since last notification → ${this.getLoopIntervalDisplay()}`);
          appendDailyLog(`⏳ Loop backoff → ${this.getLoopIntervalDisplay()} (no response from Bruce)`);
          // Restart intervals with new timing
          if (this.interval) { clearInterval(this.interval); this.interval = setInterval(() => this.runCheck().catch(() => {}), this.loopIntervalMs); }
          if (this.employeeCheckInterval) { clearInterval(this.employeeCheckInterval); this.employeeCheckInterval = setInterval(() => this.employeeSelfCheck().catch(() => {}), this.loopIntervalMs / 2); }
        }
      }

      const working = workingNow.length;
      const idle = idleEmployees.length;
      log('info', `Loop: ${employees.length} employees (${working} working, ${idle} idle), ${recentErrors} errors/hr, interval: ${this.getLoopIntervalDisplay()}`);
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
