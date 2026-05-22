import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Project } from '../models/project.model';

export interface ClaudeCodeEvent {
  type: 'start' | 'text' | 'tool_use' | 'tool_result' | 'error' | 'done' | 'task_idle' | 'token_usage' | 'turn_usage';
  content?: string;
  tool?: string;
  sessionId: string;
  timestamp: Date;
  tokenUsage?: TokenUsageData;
  turnUsage?: TurnUsageData;
}

export interface TurnUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
  tools: string[];  // tool names used in this turn
}

export interface TokenUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  model: string;
}

export interface RunCommandResult {
  sessionId: string;
  sdkSessionId?: string;
  events: ClaudeCodeEvent[];
  status: 'completed' | 'failed' | 'cancelled';
  tokenUsage?: TokenUsageData;
}

// Lazy-load the ESM-only SDK from CommonJS
// Use Function constructor to prevent ts-node from transpiling import() into require()
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
let _query: any = null;
async function getQuery() {
  if (!_query) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

export class ClaudeCodeService {
  isAvailable: boolean = false;

  // Static so all instances share the same session tracking
  private static activeSessions: Map<string, { close: () => void; sdkSessionId?: string; projectId?: string; startedAt: Date }> = new Map();
  private static pendingMessages: Map<string, string[]> = new Map();

  async checkAvailability(): Promise<{ available: boolean; version: string }> {
    // SDK uses Claude Code OAuth subscription, not ANTHROPIC_API_KEY
    // Verify the SDK can be loaded
    try {
      await getQuery();
      this.isAvailable = true;
      return { available: true, version: 'claude-agent-sdk' };
    } catch {
      this.isAvailable = false;
      return { available: false, version: '' };
    }
  }

  async runCommand(
    projectPath: string,
    prompt: string,
    onEvent: (event: ClaudeCodeEvent) => void,
    options?: { resumeSdkSessionId?: string; allowedTools?: string[]; keepAlive?: boolean; mcpServers?: Record<string, any>; model?: string; shouldContinue?: () => Promise<boolean> },
    timeoutMs?: number
  ): Promise<RunCommandResult> {
    // Validate project path — normalize to forward slashes for the SDK
    const resolvedPath = path.resolve(projectPath).replace(/\\/g, '/');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      throw new Error(`Project path does not exist: ${resolvedPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Project path is not a directory: ${resolvedPath}`);
    }

    const sessionId = crypto.randomUUID();
    const queryFn = await getQuery();
    const collectedEvents: ClaudeCodeEvent[] = [];
    let sdkSessionId: string | undefined;
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    let accumulatedUsage: TokenUsageData = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, costUsd: 0, durationMs: 0, numTurns: 0, model: 'claude-agent-sdk',
    };

    // Initialize pending messages queue for this session
    ClaudeCodeService.pendingMessages.set(sessionId, []);

    // Timeout guard — only armed when caller passes an explicit timeoutMs
    const timer = timeoutMs ? setTimeout(() => {
      const event: ClaudeCodeEvent = {
        type: 'error',
        content: `Session timed out after ${timeoutMs / 1000}s`,
        sessionId,
        timestamp: new Date(),
      };
      collectedEvents.push(event);
      onEvent(event);
      this.cancelSession(sessionId);
    }, timeoutMs) : null;

    const startEvent: ClaudeCodeEvent = { type: 'start', sessionId, timestamp: new Date() };
    collectedEvents.push(startEvent);
    onEvent(startEvent);

    // Strip ANTHROPIC_API_KEY so the SDK uses the Claude Code subscription
    const sdkEnv: Record<string, string | undefined> = { ...process.env };
    delete sdkEnv.ANTHROPIC_API_KEY;

    const baseOptions: any = {
      allowedTools: options?.allowedTools?.length ? options.allowedTools : ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebSearch'],
      cwd: resolvedPath,
      env: sdkEnv,
    };
    if (options?.model) baseOptions.model = options.model;

    // Pass MCP servers directly to the SDK (required for MCP tools to be available)
    if (options?.mcpServers && Object.keys(options.mcpServers).length > 0) {
      baseOptions.mcpServers = options.mcpServers;
    }

    let currentPrompt = prompt;
    let resumeId = options?.resumeSdkSessionId;

    let lastEventAt = Date.now();
    // Stuck detection: track last event timestamp, inject nudge if silent too long
    const STUCK_CHECK_MS = 5 * 60 * 1000; // 5 minutes
    const stuckInterval = options?.keepAlive ? setInterval(() => {
      const silentMs = Date.now() - lastEventAt;
      if (silentMs >= STUCK_CHECK_MS && ClaudeCodeService.activeSessions.has(sessionId)) {
        const pending = ClaudeCodeService.pendingMessages.get(sessionId);
        if (pending && sdkSessionId) {
          console.log(`[ClaudeCode] Session ${sessionId} silent for ${Math.round(silentMs / 60000)}min — injecting nudge`);
          pending.push('[SYSTEM NUDGE] You have been silent for 5 minutes. If you are stuck, describe what is blocking you in your working status and try a different approach. If you are waiting for something, state what. Do NOT go idle without updating your working status.');
          try { ClaudeCodeService.activeSessions.get(sessionId)?.close(); } catch {}
        }
      }
    }, STUCK_CHECK_MS) : null;

    try {
      // Loop: run conversation, check for injected messages, resume if needed
      while (true) {
        const queryOptions = { ...baseOptions };
        if (resumeId) {
          queryOptions.resume = resumeId;
        }

        const conversation = queryFn({
          prompt: currentPrompt,
          options: queryOptions,
        });

        // Store reference so we can close it on cancel/inject
        ClaudeCodeService.activeSessions.set(sessionId, {
          close: () => conversation.close(),
          sdkSessionId,
          projectId: undefined,
          startedAt: new Date(),
        });

        let closedForInjection = false;

        try {
          for await (const message of conversation) {
            // Capture SDK session ID from the first message
            if (!sdkSessionId && message.session_id) {
              sdkSessionId = message.session_id;
              // Update stored reference with sdkSessionId
              const session = ClaudeCodeService.activeSessions.get(sessionId);
              if (session) session.sdkSessionId = sdkSessionId;
            }
            lastEventAt = Date.now();
            // Capture token usage from result messages and emit per-segment event
            // SDK may put usage in message.usage, message.result.usage, or top-level fields
            if (message.type === 'result') {
              console.log(`[ClaudeCode] Result message keys: ${Object.keys(message).join(', ')} | has usage: ${!!message.usage} | has cost: ${!!message.total_cost_usd} | has modelUsage: ${!!message.modelUsage}`);
            }
            if (message.type === 'result' && (message.usage || message.total_cost_usd || message.num_turns)) {
              const u = message.usage || {};
              const segmentUsage: TokenUsageData = {
                inputTokens: u.input_tokens || message.input_tokens || 0,
                outputTokens: u.output_tokens || message.output_tokens || 0,
                cacheReadTokens: u.cache_read_input_tokens || message.cache_read_input_tokens || 0,
                cacheCreationTokens: u.cache_creation_input_tokens || message.cache_creation_input_tokens || 0,
                costUsd: message.total_cost_usd || 0,
                durationMs: message.duration_ms || message.duration || 0,
                numTurns: message.num_turns || 1,
                model: Object.keys(message.modelUsage || {})[0] || message.model || accumulatedUsage.model,
              };
              console.log(`[ClaudeCode] Token usage captured: ${segmentUsage.inputTokens} in / ${segmentUsage.outputTokens} out / $${segmentUsage.costUsd.toFixed(4)}`);
              // Accumulate for final total
              accumulatedUsage.inputTokens += segmentUsage.inputTokens;
              accumulatedUsage.outputTokens += segmentUsage.outputTokens;
              accumulatedUsage.cacheReadTokens += segmentUsage.cacheReadTokens;
              accumulatedUsage.cacheCreationTokens += segmentUsage.cacheCreationTokens;
              accumulatedUsage.costUsd += segmentUsage.costUsd;
              accumulatedUsage.durationMs += segmentUsage.durationMs;
              accumulatedUsage.numTurns += segmentUsage.numTurns;
              if (segmentUsage.model) accumulatedUsage.model = segmentUsage.model;

              // Emit per-segment token_usage event so callers can track each interaction
              const usageEvent: ClaudeCodeEvent = {
                type: 'token_usage',
                content: `Segment: ${segmentUsage.inputTokens} in / ${segmentUsage.outputTokens} out / ${segmentUsage.cacheReadTokens} cache | $${segmentUsage.costUsd.toFixed(4)}`,
                sessionId,
                timestamp: new Date(),
                tokenUsage: segmentUsage,
              };
              collectedEvents.push(usageEvent);
              onEvent(usageEvent);
            }
            this.processMessage(message, sessionId, (event) => {
              collectedEvents.push(event);
              onEvent(event);
            });
          }
        } catch (err: any) {
          // Check if this was closed for message injection
          const pending = ClaudeCodeService.pendingMessages.get(sessionId);
          if (pending && pending.length > 0 && (err.name === 'AbortError' || err.message === 'Query closed')) {
            closedForInjection = true;
          } else if (err.name === 'AbortError' || err.message === 'Query closed') {
            status = 'cancelled';
            break;
          } else {
            status = 'failed';
            const event: ClaudeCodeEvent = {
              type: 'error',
              content: err.message || 'Unknown SDK error',
              sessionId,
              timestamp: new Date(),
            };
            collectedEvents.push(event);
            onEvent(event);
            break;
          }
        }

        // Check for pending injected messages
        const pending = ClaudeCodeService.pendingMessages.get(sessionId);
        if (closedForInjection && pending && pending.length > 0 && sdkSessionId) {
          currentPrompt = pending.shift()!;
          resumeId = sdkSessionId;

          // Emit an event so the frontend/logs show the injection
          const injectEvent: ClaudeCodeEvent = {
            type: 'text',
            content: `📩 [Message injected]: ${currentPrompt}`,
            sessionId,
            timestamp: new Date(),
          };
          collectedEvents.push(injectEvent);
          onEvent(injectEvent);

          continue; // Resume the loop with the new message
        }

        // Keep-alive mode: check if employee still has work, otherwise park
        if (options?.keepAlive && sdkSessionId && status === 'completed') {
          // Ask the caller if the session should auto-continue (e.g. task result is empty)
          const shouldContinue = options.shouldContinue ? await options.shouldContinue() : false;

          if (shouldContinue) {
            console.log(`[ClaudeCode] Session ${sessionId} — task result still empty, auto-continuing`);
            currentPrompt = '[SYSTEM] Your conversation was stopped but your task is NOT done yet — you have not submitted a task result. Continue working from where you left off. Check your working status and keep going. Do NOT start over.';
            resumeId = sdkSessionId;
            continue;
          }

          // Task has a result — park and wait for injected messages
          const idleEvent: ClaudeCodeEvent = {
            type: 'task_idle', content: '💤 Task result submitted — waiting for next message',
            sessionId, timestamp: new Date(),
          };
          collectedEvents.push(idleEvent);
          onEvent(idleEvent);

          // Wait for a new message to be injected
          await new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
              const pending = ClaudeCodeService.pendingMessages.get(sessionId);
              if (pending && pending.length > 0) {
                clearInterval(checkInterval);
                resolve();
              }
              // If session was cancelled, stop waiting
              if (!ClaudeCodeService.activeSessions.has(sessionId)) {
                clearInterval(checkInterval);
                resolve();
              }
            }, 1000);
          });

          // Check if we were cancelled
          if (!ClaudeCodeService.activeSessions.has(sessionId)) break;

          const pending = ClaudeCodeService.pendingMessages.get(sessionId);
          if (pending && pending.length > 0) {
            currentPrompt = pending.shift()!;
            resumeId = sdkSessionId;
            status = 'completed'; // Reset for next round
            continue;
          }
        }

        break; // Normal completion or no keep-alive, exit loop
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (stuckInterval) clearInterval(stuckInterval);
      ClaudeCodeService.activeSessions.delete(sessionId);
      ClaudeCodeService.pendingMessages.delete(sessionId);
      const doneEvent: ClaudeCodeEvent = { type: 'done', sessionId, timestamp: new Date() };
      collectedEvents.push(doneEvent);
      onEvent(doneEvent);
    }

    const hasUsage = accumulatedUsage.inputTokens > 0 || accumulatedUsage.outputTokens > 0 || accumulatedUsage.costUsd > 0;
    return {
      sessionId, sdkSessionId, events: collectedEvents, status,
      tokenUsage: hasUsage ? accumulatedUsage : undefined,
    };
  }

  /**
   * Inject a message into a running session.
   * Closes the current conversation, queues the message, and the runCommand loop
   * will resume the SDK session with this message as the new prompt.
   */
  injectMessage(sessionId: string, message: string): boolean {
    const session = ClaudeCodeService.activeSessions.get(sessionId);
    if (!session) return false;

    const pending = ClaudeCodeService.pendingMessages.get(sessionId);
    if (!pending) return false;

    // Queue the message and close the conversation to trigger resume
    pending.push(message);
    try { session.close(); } catch {}
    return true;
  }

  /**
   * Find a session by employee taskId (which is used as the sessionId in activeSessions)
   */
  findSessionByTaskId(taskId: string): string | null {
    if (ClaudeCodeService.activeSessions.has(taskId)) return taskId;
    return null;
  }

  /** Check if a session is currently alive and running */
  isSessionAlive(sessionId: string): boolean {
    return ClaudeCodeService.activeSessions.has(sessionId);
  }

  cancelSession(sessionId: string): boolean {
    const session = ClaudeCodeService.activeSessions.get(sessionId);
    if (!session) return false;
    // Clear pending messages so the loop doesn't resume
    ClaudeCodeService.pendingMessages.delete(sessionId);
    session.close();
    ClaudeCodeService.activeSessions.delete(sessionId);
    return true;
  }

  /**
   * Run a short-lived, focused Claude Code session.
   * Returns the final text result (no streaming), with a tight timeout.
   * Designed for Alfred's hands-on investigations/fixes — no keepAlive, no resume.
   */
  async runQuick(
    projectPath: string,
    prompt: string,
    options?: { allowedTools?: string[]; timeoutMs?: number; model?: string }
  ): Promise<{ result: string; status: 'completed' | 'failed' | 'cancelled'; events: ClaudeCodeEvent[] }> {
    const timeout = options?.timeoutMs || 3 * 60 * 1000; // 3 min default
    const tools = options?.allowedTools || ['Read', 'Glob', 'Grep', 'Bash'];
    const allEvents: ClaudeCodeEvent[] = [];

    const { status } = await this.runCommand(
      projectPath,
      prompt,
      (event) => allEvents.push(event),
      { allowedTools: tools, keepAlive: false, model: options?.model },
      timeout,
    );

    // Extract text from events — last text block is typically the final summary
    const textParts = allEvents
      .filter(e => e.type === 'text' && e.content)
      .map(e => e.content!);

    const result = textParts.length > 0
      ? textParts[textParts.length - 1]
      : (status === 'failed' ? 'Session failed with no output' : 'No result produced');

    return { result, status, events: allEvents };
  }

  /** Get all currently running sessions */
  getActiveSessions(): { sessionId: string; projectId?: string; startedAt: Date }[] {
    return Array.from(ClaudeCodeService.activeSessions.entries()).map(([sessionId, s]) => ({
      sessionId,
      projectId: s.projectId,
      startedAt: s.startedAt,
    }));
  }

  /** Stop all running sessions */
  stopAllSessions(): number {
    let count = 0;
    for (const [sessionId, session] of ClaudeCodeService.activeSessions) {
      try { session.close(); } catch {}
      ClaudeCodeService.activeSessions.delete(sessionId);
      count++;
    }
    return count;
  }

  /** Mark stale "running" sessions in DB as cancelled (for crash recovery) */
  async cleanupStaleSessions(): Promise<number> {
    try {
      const result = await Project.updateMany(
        { 'agentSessions.status': 'running' },
        { $set: { 'agentSessions.$[elem].status': 'cancelled', 'agentSessions.$[elem].completedAt': new Date() } },
        { arrayFilters: [{ 'elem.status': 'running' }] }
      );
      return result.modifiedCount || 0;
    } catch {
      return 0;
    }
  }

  private processMessage(
    message: any,
    sessionId: string,
    onEvent: (event: ClaudeCodeEvent) => void
  ): void {
    if (!message || !message.type) return;

    // Result message (query complete)
    if (message.type === 'result') {
      if (message.result) {
        onEvent({ type: 'text', content: message.result, sessionId, timestamp: new Date() });
      }
      return;
    }

    // Assistant message with content blocks
    if (message.type === 'assistant' && message.message?.content) {
      const tools: string[] = [];
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          onEvent({ type: 'text', content: block.text, sessionId, timestamp: new Date() });
        } else if (block.type === 'tool_use') {
          tools.push(block.name);
          onEvent({
            type: 'tool_use',
            content: JSON.stringify(block.input),
            tool: block.name,
            sessionId,
            timestamp: new Date(),
          });
        }
      }
      // Emit per-turn usage if the API response includes usage data
      const u = message.message?.usage;
      if (u && (u.input_tokens || u.output_tokens)) {
        const turnData: TurnUsageData = {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          model: message.message?.model || 'claude-agent-sdk',
          tools,
        };
        onEvent({
          type: 'turn_usage',
          content: `Turn: ${turnData.inputTokens} in / ${turnData.outputTokens} out | tools: ${tools.join(', ') || 'none'}`,
          sessionId,
          timestamp: new Date(),
          turnUsage: turnData,
        });
      }
      return;
    }

    // User message (tool results from SDK's internal tool execution)
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join('')
              : JSON.stringify(block.content);
          onEvent({ type: 'tool_result', content, sessionId, timestamp: new Date() });
        }
      }
      return;
    }

    // System/status messages — skip silently
    if (['system', 'status', 'compact_boundary', 'auth_status', 'rate_limit'].includes(message.type)) {
      return;
    }
  }
}
