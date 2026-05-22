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

export interface ProxyUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  model: string;
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
      console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [ClaudeProxy] Retry attempt ${attempt}/${maxRetries}`);
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
      console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [ClaudeProxy] Attempt ${attempt + 1} failed: ${err.message}`);

      // Don't retry on auth errors
      if (err.message?.includes('auth') || err.message?.includes('permission')) {
        throw err;
      }
    }
  }

  console.error(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [ClaudeProxy] All ${maxRetries + 1} attempts failed. Last error: ${lastError?.message}`);
  throw lastError || new Error('Claude chat failed after retries');
}

// Internal tracking: last usage from most recent doQuery call
let _lastUsage: ProxyUsageData | null = null;

/** Get the usage data from the most recent claudeChat call */
export function getLastUsage(): ProxyUsageData | null {
  return _lastUsage;
}

async function doQuery(opts: ProxyOptions): Promise<string> {
  const queryFn = await getQuery();
  _lastUsage = null;

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
  console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [ClaudeProxy] doQuery: model=${opts.model || 'default'}, prompt=${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  const queryStart = Date.now();

  // Strip ANTHROPIC_API_KEY so the SDK uses OAuth
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  delete sdkEnv.ANTHROPIC_API_KEY;

  const queryOpts: any = {
    allowedTools: [],   // chat only, no tools — SDK can't loop
    env: sdkEnv,
  };
  if (opts.model) queryOpts.model = opts.model;

  const conversation = queryFn({
    prompt,
    options: queryOpts,
  });

  let result = '';
  let resultMsgInfo: { subtype?: string; isError?: boolean; hasResult?: boolean } | null = null;
  const seenTypes: string[] = [];
  for await (const message of conversation) {
    seenTypes.push(message.type + (message.subtype ? `:${message.subtype}` : ''));
    if (message.type === 'result') {
      resultMsgInfo = {
        subtype: message.subtype,
        isError: message.is_error,
        hasResult: !!message.result,
      };
      if (message.result) result = message.result;
      // Capture usage
      if (message.usage) {
        const u = message.usage;
        const modelKeys = Object.keys(message.modelUsage || {});
        _lastUsage = {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          costUsd: message.total_cost_usd || 0,
          durationMs: message.duration_ms || 0,
          numTurns: message.num_turns || 0,
          model: modelKeys[0] || 'claude-agent-sdk',
        };
      }
    } else if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          result += block.text;
        }
      }
    }
  }

  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [ClaudeProxy] doQuery: completed in ${((Date.now() - queryStart) / 1000).toFixed(1)}s, result=${result.length} chars${_lastUsage ? `, ${_lastUsage.inputTokens} in / ${_lastUsage.outputTokens} out` : ''}`);

  // Diagnostic: when result is empty, log the message stream so we can tell rate-limit from auth from max-turns
  if (!result) {
    console.error(`[${ts}] [ClaudeProxy] EMPTY RESULT — messages seen: [${seenTypes.join(', ')}], resultMsg=${JSON.stringify(resultMsgInfo)}, usage=${JSON.stringify(_lastUsage)}`);
    // Surface the SDK's actual error subtype so callers (and retry logic) can react
    if (resultMsgInfo?.isError || resultMsgInfo?.subtype?.startsWith('error_')) {
      throw new Error(`Claude SDK error: ${resultMsgInfo.subtype || 'unknown'}`);
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
