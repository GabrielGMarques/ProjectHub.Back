import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Project } from '../models/project.model';

export interface ClaudeCodeEvent {
  type: 'start' | 'text' | 'tool_use' | 'tool_result' | 'error' | 'done';
  content?: string;
  tool?: string;
  sessionId: string;
  timestamp: Date;
}

export interface RunCommandResult {
  sessionId: string;
  sdkSessionId?: string;
  events: ClaudeCodeEvent[];
  status: 'completed' | 'failed' | 'cancelled';
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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

  private activeSessions: Map<string, { close: () => void; sdkSessionId?: string; projectId?: string; startedAt: Date }> = new Map();
  private pendingMessages: Map<string, string[]> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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
    options?: { resumeSdkSessionId?: string; allowedTools?: string[] },
    timeoutMs: number = DEFAULT_TIMEOUT_MS
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

    // Initialize pending messages queue for this session
    this.pendingMessages.set(sessionId, []);

    // Timeout guard
    const timer = setTimeout(() => {
      const event: ClaudeCodeEvent = {
        type: 'error',
        content: `Session timed out after ${timeoutMs / 1000}s`,
        sessionId,
        timestamp: new Date(),
      };
      collectedEvents.push(event);
      onEvent(event);
      this.cancelSession(sessionId);
    }, timeoutMs);

    const startEvent: ClaudeCodeEvent = { type: 'start', sessionId, timestamp: new Date() };
    collectedEvents.push(startEvent);
    onEvent(startEvent);

    // Strip ANTHROPIC_API_KEY so the SDK uses the Claude Code subscription
    const sdkEnv: Record<string, string | undefined> = { ...process.env };
    delete sdkEnv.ANTHROPIC_API_KEY;

    const baseOptions: any = {
      allowedTools: options?.allowedTools?.length ? options.allowedTools : ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
      cwd: resolvedPath,
      maxTurns: 50,
      env: sdkEnv,
    };

    let currentPrompt = prompt;
    let resumeId = options?.resumeSdkSessionId;

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
        this.activeSessions.set(sessionId, {
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
              const session = this.activeSessions.get(sessionId);
              if (session) session.sdkSessionId = sdkSessionId;
            }
            this.processMessage(message, sessionId, (event) => {
              collectedEvents.push(event);
              onEvent(event);
            });
          }
        } catch (err: any) {
          // Check if this was closed for message injection
          const pending = this.pendingMessages.get(sessionId);
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
        const pending = this.pendingMessages.get(sessionId);
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

        break; // Normal completion, exit loop
      }
    } finally {
      clearTimeout(timer);
      this.activeSessions.delete(sessionId);
      this.pendingMessages.delete(sessionId);
      const doneEvent: ClaudeCodeEvent = { type: 'done', sessionId, timestamp: new Date() };
      collectedEvents.push(doneEvent);
      onEvent(doneEvent);
    }

    return { sessionId, sdkSessionId, events: collectedEvents, status };
  }

  /**
   * Inject a message into a running session.
   * Closes the current conversation, queues the message, and the runCommand loop
   * will resume the SDK session with this message as the new prompt.
   */
  injectMessage(sessionId: string, message: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    const pending = this.pendingMessages.get(sessionId);
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
    if (this.activeSessions.has(taskId)) return taskId;
    return null;
  }

  cancelSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    // Clear pending messages so the loop doesn't resume
    this.pendingMessages.delete(sessionId);
    session.close();
    this.activeSessions.delete(sessionId);
    return true;
  }

  /** Get all currently running sessions */
  getActiveSessions(): { sessionId: string; projectId?: string; startedAt: Date }[] {
    return Array.from(this.activeSessions.entries()).map(([sessionId, s]) => ({
      sessionId,
      projectId: s.projectId,
      startedAt: s.startedAt,
    }));
  }

  /** Stop all running sessions */
  stopAllSessions(): number {
    let count = 0;
    for (const [sessionId, session] of this.activeSessions) {
      try { session.close(); } catch {}
      this.activeSessions.delete(sessionId);
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

  /** Start periodic cleanup of timed-out sessions */
  startCleanupRoutine(intervalMs: number = 5 * 60 * 1000): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.activeSessions) {
        const elapsed = now - session.startedAt.getTime();
        if (elapsed > DEFAULT_TIMEOUT_MS) {
          console.log(`[ClaudeCode] Stopping timed-out session: ${sessionId}`);
          try { session.close(); } catch {}
          this.activeSessions.delete(sessionId);
        }
      }
    }, intervalMs);
  }

  stopCleanupRoutine(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
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
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          onEvent({ type: 'text', content: block.text, sessionId, timestamp: new Date() });
        } else if (block.type === 'tool_use') {
          onEvent({
            type: 'tool_use',
            content: JSON.stringify(block.input),
            tool: block.name,
            sessionId,
            timestamp: new Date(),
          });
        }
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
