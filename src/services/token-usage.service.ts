import { TokenUsage } from '../models/token-usage.model';

export class TokenUsageService {

  /**
   * Record a token usage entry from any source.
   * Fire-and-forget — never let tracking failures break the app.
   */
  async record(data: {
    userId: string;
    employeeId?: string;
    projectId?: string;
    source: 'employee' | 'alfred' | 'strategic-chat' | 'coach';
    aiModel?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      const input = data.inputTokens || 0;
      const output = data.outputTokens || 0;
      const cacheRead = data.cacheReadTokens || 0;
      const cacheCreation = data.cacheCreationTokens || 0;
      await TokenUsage.create({
        ...data,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        totalTokens: input + output + cacheRead + cacheCreation,
      });
    } catch (err) {
      console.error('[TokenUsage] Failed to record:', err);
    }
  }

  /**
   * Extract usage data from a Claude Agent SDK result message.
   */
  extractFromSdkResult(resultMsg: any): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    durationMs: number;
    numTurns: number;
    model: string;
  } | null {
    if (!resultMsg || resultMsg.type !== 'result') return null;

    const usage = resultMsg.usage || {};
    const modelUsage = resultMsg.modelUsage || {};
    const modelName = Object.keys(modelUsage)[0] || 'claude-agent-sdk';

    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      costUsd: resultMsg.total_cost_usd || 0,
      durationMs: resultMsg.duration_ms || 0,
      numTurns: resultMsg.num_turns || 0,
      model: modelName,
    };
  }

  /**
   * Extract usage from an OpenAI response.
   */
  extractFromOpenAI(response: any): {
    inputTokens: number;
    outputTokens: number;
    model: string;
  } | null {
    if (!response?.usage) return null;
    return {
      inputTokens: response.usage.prompt_tokens || 0,
      outputTokens: response.usage.completion_tokens || 0,
      model: response.model || 'gpt-4o',
    };
  }

  /**
   * Extract usage from a Gemini response.
   */
  extractFromGemini(response: any): {
    inputTokens: number;
    outputTokens: number;
    model: string;
  } | null {
    const meta = response?.response?.usageMetadata;
    if (!meta) return null;
    return {
      inputTokens: meta.promptTokenCount || 0,
      outputTokens: meta.candidatesTokenCount || 0,
      model: 'gemini-2.5-flash',
    };
  }

  /**
   * Get aggregated stats for a user over a time period.
   */
  async getStats(userId: string, days: number = 7): Promise<{
    totalTokens: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCalls: number;
    avgTokensPerCall: number;
    avgCostPerCall: number;
    bySource: { source: string; tokens: number; cost: number; calls: number }[];
    byEmployee: { employeeId: string; name: string; avatar: string; role: string; tokens: number; cost: number; calls: number }[];
    byModel: { aiModel: string; tokens: number; cost: number; calls: number }[];
    dailyBreakdown: { date: string; tokens: number; cost: number; calls: number }[];
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await TokenUsage.find({
      userId,
      createdAt: { $gte: since },
    })
      .populate('employeeId', 'name avatar role')
      .lean();

    const totalTokens = records.reduce((s, r) => s + r.totalTokens, 0);
    const totalCostUsd = records.reduce((s, r) => s + r.costUsd, 0);
    const inputTokens = records.reduce((s, r) => s + r.inputTokens, 0);
    const outputTokens = records.reduce((s, r) => s + r.outputTokens, 0);
    const cacheReadTokens = records.reduce((s, r) => s + r.cacheReadTokens, 0);
    const cacheCreationTokens = records.reduce((s, r) => s + r.cacheCreationTokens, 0);
    const totalCalls = records.length;

    // By source
    const sourceMap = new Map<string, { tokens: number; cost: number; calls: number }>();
    for (const r of records) {
      const s = sourceMap.get(r.source) || { tokens: 0, cost: 0, calls: 0 };
      s.tokens += r.totalTokens;
      s.cost += r.costUsd;
      s.calls++;
      sourceMap.set(r.source, s);
    }
    const bySource = Array.from(sourceMap.entries())
      .map(([source, data]) => ({ source, ...data }))
      .sort((a, b) => b.tokens - a.tokens);

    // By employee
    const empMap = new Map<string, { name: string; avatar: string; role: string; tokens: number; cost: number; calls: number }>();
    for (const r of records) {
      if (!r.employeeId) continue;
      const emp: any = r.employeeId;
      const id = emp._id?.toString() || emp.toString();
      const existing = empMap.get(id) || { name: emp.name || 'Unknown', avatar: emp.avatar || '', role: emp.role || '', tokens: 0, cost: 0, calls: 0 };
      existing.tokens += r.totalTokens;
      existing.cost += r.costUsd;
      existing.calls++;
      empMap.set(id, existing);
    }
    const byEmployee = Array.from(empMap.entries())
      .map(([employeeId, data]) => ({ employeeId, ...data }))
      .sort((a, b) => b.tokens - a.tokens);

    // By model
    const modelMap = new Map<string, { tokens: number; cost: number; calls: number }>();
    for (const r of records) {
      const m = modelMap.get(r.aiModel) || { tokens: 0, cost: 0, calls: 0 };
      m.tokens += r.totalTokens;
      m.cost += r.costUsd;
      m.calls++;
      modelMap.set(r.aiModel, m);
    }
    const byModel = Array.from(modelMap.entries())
      .map(([aiModel, data]) => ({ aiModel, ...data }))
      .sort((a, b) => b.tokens - a.tokens);

    // Daily breakdown
    const dailyMap = new Map<string, { tokens: number; cost: number; calls: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dailyMap.set(d.toISOString().split('T')[0], { tokens: 0, cost: 0, calls: 0 });
    }
    for (const r of records) {
      const key = new Date(r.createdAt).toISOString().split('T')[0];
      const day = dailyMap.get(key);
      if (day) {
        day.tokens += r.totalTokens;
        day.cost += r.costUsd;
        day.calls++;
      }
    }
    const dailyBreakdown = Array.from(dailyMap.entries())
      .map(([date, data]) => ({ date, ...data }))
      .reverse();

    return {
      totalTokens,
      totalCostUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalCalls,
      avgTokensPerCall: totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0,
      avgCostPerCall: totalCalls > 0 ? totalCostUsd / totalCalls : 0,
      bySource,
      byEmployee,
      byModel,
      dailyBreakdown,
    };
  }

  /**
   * Get recent individual usage records.
   */
  async getRecent(userId: string, limit: number = 50): Promise<any[]> {
    return TokenUsage.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('employeeId', 'name avatar role')
      .populate('projectId', 'name')
      .lean();
  }
}
