/**
 * Claude Proxy Service
 *
 * Routes all Anthropic/Claude API calls through the Claude Agent SDK,
 * which uses the user's Claude Code subscription (OAuth) instead of
 * ANTHROPIC_API_KEY. This means no API credits are consumed — all
 * calls go through the Claude subscription.
 *
 * Drop-in replacement for `anthropic.messages.create()`.
 */

// Lazy-load the ESM-only SDK from CommonJS
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
let _query: any = null;

async function getQuery() {
  if (!_query) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

export interface ProxyMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProxyOptions {
  system?: string;
  messages: ProxyMessage[];
  maxTokens?: number;
  model?: string;
}

/**
 * Send a chat completion through the Claude Agent SDK.
 * Uses your Claude Code subscription — no ANTHROPIC_API_KEY needed.
 * Includes retry with backoff for resilience.
 */
export async function claudeChat(opts: ProxyOptions & { timeoutMs?: number; retries?: number }): Promise<string> {
  const timeoutMs = opts.timeoutMs || 120_000;
  const maxRetries = opts.retries ?? 2;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 8000);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[ClaudeProxy] Retry attempt ${attempt}/${maxRetries}`);
    }

    try {
      const result = await Promise.race([
        doQuery(opts),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`Claude response timed out after ${timeoutMs / 1000}s`)), timeoutMs)
        ),
      ]);

      if (result) return result;
      lastError = new Error('Empty response from Claude');
    } catch (err: any) {
      lastError = err;
      console.log(`[ClaudeProxy] Attempt ${attempt + 1} failed: ${err.message}`);

      // Don't retry on auth errors
      if (err.message?.includes('auth') || err.message?.includes('permission')) {
        throw err;
      }
    }
  }

  throw lastError || new Error('Claude chat failed after retries');
}

async function doQuery(opts: ProxyOptions): Promise<string> {
  const queryFn = await getQuery();

  // Build a single prompt from system + messages
  const parts: string[] = [];
  if (opts.system) {
    parts.push(`[System Instructions]\n${opts.system}\n[End System Instructions]`);
  }

  for (const msg of opts.messages) {
    if (msg.role === 'user') {
      parts.push(`User: ${msg.content}`);
    } else {
      parts.push(`Assistant: ${msg.content}`);
    }
  }

  const prompt = parts.join('\n\n');

  // Strip ANTHROPIC_API_KEY so the SDK uses OAuth
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  delete sdkEnv.ANTHROPIC_API_KEY;

  const conversation = queryFn({
    prompt,
    options: {
      allowedTools: [],   // chat only, no tools
      maxTurns: 1,        // single response
      env: sdkEnv,
    },
  });

  let result = '';
  for await (const message of conversation) {
    if (message.type === 'result' && message.result) {
      result = message.result;
    } else if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          result += block.text;
        }
      }
    }
  }

  return result;
}

/** Check if the Claude Agent SDK is available (user logged into Claude Code) */
export async function isClaudeAvailable(): Promise<boolean> {
  try {
    await getQuery();
    return true;
  } catch {
    return false;
  }
}
