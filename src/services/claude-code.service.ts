import { spawn, ChildProcess } from 'child_process';
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

interface AvailabilityResult {
  available: boolean;
  version: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class ClaudeCodeService {
  isAvailable: boolean = false;

  private sessions: Map<string, ChildProcess> = new Map();

  private getCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    return env;
  }

  async checkAvailability(): Promise<AvailabilityResult> {
    return new Promise<AvailabilityResult>((resolve) => {
      const child = spawn('claude', ['--version'], { shell: true, env: this.getCleanEnv() });
      let output = '';

      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      child.on('error', () => {
        this.isAvailable = false;
        resolve({ available: false, version: '' });
      });

      child.on('close', (code) => {
        if (code === 0) {
          const version = output.trim();
          this.isAvailable = true;
          resolve({ available: true, version });
        } else {
          this.isAvailable = false;
          resolve({ available: false, version: '' });
        }
      });
    });
  }

  async runCommand(
    projectPath: string,
    prompt: string,
    onEvent: (event: ClaudeCodeEvent) => void,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<void> {
    // Validate that projectPath exists and is a directory
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

    // Emit start event
    onEvent({
      type: 'start',
      sessionId,
      timestamp: new Date(),
    });

    return new Promise<void>((resolve, reject) => {
      // Spawn claude CLI with argument array - never pass user input to shell directly
      const child = spawn(
        'claude',
        ['-p', prompt, '--output-format', 'stream-json'],
        { cwd: resolvedPath, shell: true, env: this.getCleanEnv() }
      );

      this.sessions.set(sessionId, child);

      // Set timeout to kill runaway processes
      const timer = setTimeout(() => {
        if (this.sessions.has(sessionId)) {
          onEvent({
            type: 'error',
            content: `Session timed out after ${timeoutMs / 1000} seconds`,
            sessionId,
            timestamp: new Date(),
          });
          this.cancelSession(sessionId);
        }
      }, timeoutMs);

      let stderrOutput = '';
      let lineBuffer = '';

      child.stdout.on('data', (data: Buffer) => {
        lineBuffer += data.toString();

        // Process complete lines from the JSONL stream
        const lines = lineBuffer.split('\n');
        // Keep the last (potentially incomplete) chunk in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            const event = this.mapToEvent(parsed, sessionId);
            onEvent(event);
          } catch {
            // If line can't be parsed as JSON, emit as text event
            onEvent({
              type: 'text',
              content: trimmed,
              sessionId,
              timestamp: new Date(),
            });
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.sessions.delete(sessionId);
        onEvent({
          type: 'error',
          content: err.message,
          sessionId,
          timestamp: new Date(),
        });
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.sessions.delete(sessionId);

        // Flush any remaining data in the line buffer
        if (lineBuffer.trim()) {
          try {
            const parsed = JSON.parse(lineBuffer.trim());
            const event = this.mapToEvent(parsed, sessionId);
            onEvent(event);
          } catch {
            onEvent({
              type: 'text',
              content: lineBuffer.trim(),
              sessionId,
              timestamp: new Date(),
            });
          }
        }

        if (code !== 0 && code !== null) {
          const errorMsg = stderrOutput.trim() || `claude process exited with code ${code}`;
          onEvent({
            type: 'error',
            content: errorMsg,
            sessionId,
            timestamp: new Date(),
          });
        }

        onEvent({
          type: 'done',
          sessionId,
          timestamp: new Date(),
        });

        resolve();
      });
    });
  }

  cancelSession(sessionId: string): boolean {
    const child = this.sessions.get(sessionId);
    if (!child) {
      return false;
    }

    child.kill('SIGTERM');

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, 5000);

    this.sessions.delete(sessionId);
    return true;
  }

  private mapToEvent(parsed: Record<string, unknown>, sessionId: string): ClaudeCodeEvent {
    // Map Claude CLI stream-json objects to ClaudeCodeEvent
    const type = parsed.type as string | undefined;

    if (type === 'assistant' || type === 'content_block_delta') {
      return {
        type: 'text',
        content: this.extractTextContent(parsed),
        sessionId,
        timestamp: new Date(),
      };
    }

    if (type === 'tool_use' || type === 'content_block_start') {
      const toolName = (parsed.tool_name as string)
        || ((parsed.content_block as Record<string, unknown>)?.name as string)
        || undefined;
      if (toolName) {
        return {
          type: 'tool_use',
          content: JSON.stringify(parsed),
          tool: toolName,
          sessionId,
          timestamp: new Date(),
        };
      }
    }

    if (type === 'tool_result' || type === 'result') {
      return {
        type: 'tool_result',
        content: this.extractTextContent(parsed),
        sessionId,
        timestamp: new Date(),
      };
    }

    if (type === 'error') {
      return {
        type: 'error',
        content: (parsed.message as string) || (parsed.error as string) || JSON.stringify(parsed),
        sessionId,
        timestamp: new Date(),
      };
    }

    // Default: emit as text with the raw JSON stringified
    return {
      type: 'text',
      content: JSON.stringify(parsed),
      sessionId,
      timestamp: new Date(),
    };
  }

  private extractTextContent(parsed: Record<string, unknown>): string {
    // Try common content locations in Claude CLI stream-json output
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.result === 'string') return parsed.result;

    if (parsed.delta && typeof parsed.delta === 'object') {
      const delta = parsed.delta as Record<string, unknown>;
      if (typeof delta.text === 'string') return delta.text;
    }

    if (Array.isArray(parsed.content)) {
      return (parsed.content as Record<string, unknown>[])
        .filter((block) => block.type === 'text')
        .map((block) => block.text as string)
        .join('');
    }

    return JSON.stringify(parsed);
  }
}
