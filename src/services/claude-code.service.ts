import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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

  private activeSessions: Map<string, { close: () => void }> = new Map();

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
    options?: { resumeSdkSessionId?: string },
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<RunCommandResult> {
    // Validate project path
    const resolvedPath = path.resolve(projectPath);
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

    try {
      // Strip ANTHROPIC_API_KEY so the SDK uses the Claude Code subscription
      // (OAuth) instead of the raw API key used by the AI coach
      const sdkEnv: Record<string, string | undefined> = { ...process.env };
      delete sdkEnv.ANTHROPIC_API_KEY;

      const queryOptions: any = {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        cwd: resolvedPath,
        maxTurns: 50,
        env: sdkEnv,
      };

      // Resume an existing SDK session if provided
      if (options?.resumeSdkSessionId) {
        queryOptions.resume = options.resumeSdkSessionId;
      }

      const conversation = queryFn({
        prompt,
        options: queryOptions,
      });

      // Store reference so we can close it on cancel
      this.activeSessions.set(sessionId, conversation);

      for await (const message of conversation) {
        // Capture SDK session ID from the first message
        if (!sdkSessionId && message.session_id) {
          sdkSessionId = message.session_id;
        }
        this.processMessage(message, sessionId, (event) => {
          collectedEvents.push(event);
          onEvent(event);
        });
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message === 'Query closed') {
        status = 'cancelled';
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
      }
    } finally {
      clearTimeout(timer);
      this.activeSessions.delete(sessionId);
      const doneEvent: ClaudeCodeEvent = { type: 'done', sessionId, timestamp: new Date() };
      collectedEvents.push(doneEvent);
      onEvent(doneEvent);
    }

    return { sessionId, sdkSessionId, events: collectedEvents, status };
  }

  cancelSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    session.close();
    this.activeSessions.delete(sessionId);
    return true;
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
