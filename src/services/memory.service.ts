/**
 * Memory Service — Alfred's Long-Term Memory (RAG)
 *
 * Provides:
 *  - Embedding generation via OpenAI text-embedding-3-small
 *  - Cosine similarity search (in-process, no vector DB needed)
 *  - Memory creation from conversations, daily logs, weekly rollups
 *  - Retrieval with hybrid scoring (semantic + recency + importance)
 *  - Graceful degradation when OPENAI_API_KEY is not set
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { MemoryEntry, IMemoryEntry } from '../models/memory.model';
import { claudeChat } from './claude-proxy.service';

// ── OpenAI client (for embeddings only) ──
let openai: OpenAI | null = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── Constants ──
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims, ~$0.02/1M tokens
const MAX_EMBED_CHARS = 8000;   // ~2000 tokens safe limit
const MAX_CANDIDATES = 100;     // brute-force pool size
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_RECENCY_BOOST = 0.3;
const MEMORY_BUDGET_CHARS = 1500; // max chars injected into system prompt

// ── Cosine Similarity ──
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Memory Service ──
export class MemoryService {

  /** Generate embedding vector. Returns [] if OpenAI unavailable. */
  async embed(text: string): Promise<number[]> {
    if (!openai) return [];
    try {
      const input = text.substring(0, MAX_EMBED_CHARS);
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input,
      });
      return response.data[0].embedding;
    } catch (err: any) {
      console.log(`[Memory] Embedding failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Store a new memory entry.
   */
  async store(opts: {
    userId: string;
    content: string;
    source: IMemoryEntry['source'];
    granularity: IMemoryEntry['granularity'];
    dateRange: { start: Date; end: Date };
    projectIds?: string[];
    tags?: string[];
    importance?: number;
    parentMemoryId?: string;
  }): Promise<IMemoryEntry> {
    const embedding = await this.embed(opts.content);

    return MemoryEntry.create({
      userId: opts.userId,
      content: opts.content,
      source: opts.source,
      granularity: opts.granularity,
      dateRange: opts.dateRange,
      embedding,
      projectIds: opts.projectIds || [],
      tags: opts.tags || [],
      importance: opts.importance ?? 5,
      parentMemoryId: opts.parentMemoryId,
      accessCount: 0,
      lastAccessedAt: new Date(),
    });
  }

  /**
   * Retrieve relevant memories using hybrid scoring:
   *   score = (cosineSimilarity * (1 - recencyBoost)) + (recencyScore * recencyBoost)
   *   finalScore = score * (0.7 + 0.3 * importance / 10)
   *
   * Falls back to recency-only when embeddings are unavailable.
   */
  async retrieveRelevant(
    userId: string,
    query: string,
    opts?: {
      maxResults?: number;
      projectId?: string;
      recencyBoost?: number;
    }
  ): Promise<{ content: string; source: string; granularity: string; dateRange: { start: Date; end: Date }; score: number }[]> {
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
    const recencyBoost = opts?.recencyBoost ?? DEFAULT_RECENCY_BOOST;

    // Build filter
    const filter: any = { userId };
    if (opts?.projectId) {
      filter.projectIds = opts.projectId;
    }

    // Fetch candidates — most recent first
    const candidates = await MemoryEntry.find(filter)
      .sort({ createdAt: -1 })
      .limit(MAX_CANDIDATES)
      .lean();

    if (candidates.length === 0) return [];

    // Embed the query
    const queryEmbedding = await this.embed(query);
    const hasEmbeddings = queryEmbedding.length > 0;

    // Score each candidate
    const now = Date.now();
    const scored = candidates.map(c => {
      // Semantic similarity (0 if no embeddings)
      let similarity = 0;
      if (hasEmbeddings && c.embedding?.length > 0) {
        similarity = cosineSimilarity(queryEmbedding, c.embedding);
      }

      // Recency score: 1.0 for today, decays to 0 at 90 days
      const ageInDays = (now - new Date(c.createdAt).getTime()) / (86400 * 1000);
      const recencyScore = Math.max(0, 1 - ageInDays / 90);

      // Hybrid score
      let score: number;
      if (hasEmbeddings) {
        score = similarity * (1 - recencyBoost) + recencyScore * recencyBoost;
      } else {
        // No embeddings — pure recency
        score = recencyScore;
      }

      // Importance boost
      const importance = c.importance ?? 5;
      score *= 0.7 + 0.3 * (importance / 10);

      return { ...c, score, similarity, recencyScore };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Deduplicate: if a weekly summary and its daily child both appear, prefer the weekly
    const parentIds = new Set(
      scored.filter(s => s.granularity === 'week' || s.granularity === 'month').map(s => s._id.toString())
    );
    const deduped = scored.filter(s => {
      if (s.parentMemoryId && parentIds.has(s.parentMemoryId.toString())) return false;
      return true;
    });

    // Take top N
    const top = deduped.slice(0, maxResults);

    // Update access stats (fire-and-forget)
    const ids = top.map(t => t._id);
    MemoryEntry.updateMany(
      { _id: { $in: ids } },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } }
    ).catch(() => {});

    return top.map(t => ({
      content: t.content,
      source: t.source,
      granularity: t.granularity,
      dateRange: t.dateRange,
      score: t.score,
    }));
  }

  /**
   * Format retrieved memories for injection into the system prompt.
   * Capped at MEMORY_BUDGET_CHARS.
   */
  formatForContext(memories: { content: string; granularity: string; dateRange: { start: Date; end: Date } }[]): string {
    if (memories.length === 0) return '';

    const lines: string[] = [];
    let charCount = 0;

    for (const m of memories) {
      const dateStr = new Date(m.dateRange.start).toISOString().split('T')[0];
      const line = `[${dateStr}, ${m.granularity}] ${m.content}`;

      if (charCount + line.length > MEMORY_BUDGET_CHARS) {
        // Truncate this entry to fit
        const remaining = MEMORY_BUDGET_CHARS - charCount;
        if (remaining > 50) {
          lines.push(line.substring(0, remaining) + '...');
        }
        break;
      }

      lines.push(line);
      charCount += line.length + 1; // +1 for newline
    }

    return `=== LONG-TERM MEMORY (recalled from past days) ===\n${lines.join('\n')}\n`;
  }

  /**
   * Summarize a conversation segment and store it as a memory.
   * Called after every ~5 user messages or after significant actions.
   */
  async createConversationMemory(
    userId: string,
    messages: { role: string; content: string }[],
  ): Promise<IMemoryEntry | null> {
    if (messages.length === 0) return null;

    try {
      const transcript = messages
        .map(m => `${m.role === 'user' ? 'Bruce' : 'Alfred'}: ${m.content.substring(0, 500)}`)
        .join('\n');

      const summary = await claudeChat({
        system: `You are summarizing a conversation between Alfred (AI manager) and Bruce (the boss).
Extract ONLY the key facts: decisions made, tasks assigned, issues discussed, project names, employee names, outcomes.
Be factual, concise, under 300 words. No fluff, no opinions — just what happened.`,
        messages: [{ role: 'user', content: `Summarize this conversation:\n\n${transcript}` }],
        timeoutMs: 30_000,
        retries: 1,
      });

      const now = new Date();
      const firstMsgTime = new Date(now.getTime() - messages.length * 60000); // rough estimate

      return this.store({
        userId,
        content: summary,
        source: 'conversation',
        granularity: 'conversation',
        dateRange: { start: firstMsgTime, end: now },
        importance: 5,
      });
    } catch (err: any) {
      console.log(`[Memory] Conversation memory failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Create an end-of-day summary from the daily log file.
   */
  async createDailySummary(userId: string, logContent: string, date: Date): Promise<IMemoryEntry | null> {
    if (!logContent || logContent.length < 100) return null;

    // Check if we already have a daily summary for this date
    const dateStr = date.toISOString().split('T')[0];
    const existing = await MemoryEntry.findOne({
      userId,
      source: 'daily_summary',
      'dateRange.start': {
        $gte: new Date(dateStr + 'T00:00:00Z'),
        $lt: new Date(dateStr + 'T23:59:59Z'),
      },
    });
    if (existing) return existing; // already summarized

    try {
      const summary = await claudeChat({
        system: `You are Alfred reviewing your daily log. Summarize this day in 200-400 words.
Include: key decisions made, tasks completed/failed, revenue impacts, patterns noticed, unresolved issues.
Group by project when possible. Be factual and specific — names, numbers, outcomes.`,
        messages: [{ role: 'user', content: `Daily log for ${dateStr}:\n\n${logContent.substring(0, 15000)}` }],
        timeoutMs: 60_000,
        retries: 1,
      });

      const startOfDay = new Date(dateStr + 'T00:00:00Z');
      const endOfDay = new Date(dateStr + 'T23:59:59Z');

      return this.store({
        userId,
        content: summary,
        source: 'daily_summary',
        granularity: 'day',
        dateRange: { start: startOfDay, end: endOfDay },
        importance: 6,
      });
    } catch (err: any) {
      console.log(`[Memory] Daily summary failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Create a weekly rollup from daily summaries.
   */
  async createWeeklySummary(userId: string, weekStart: Date): Promise<IMemoryEntry | null> {
    const weekEnd = new Date(weekStart.getTime() + 7 * 86400 * 1000);

    // Check if we already have this week's summary
    const existing = await MemoryEntry.findOne({
      userId,
      source: 'weekly_summary',
      'dateRange.start': weekStart,
    });
    if (existing) return existing;

    // Fetch daily summaries for the week
    const dailies = await MemoryEntry.find({
      userId,
      source: 'daily_summary',
      'dateRange.start': { $gte: weekStart, $lt: weekEnd },
    }).sort({ 'dateRange.start': 1 }).lean();

    if (dailies.length < 2) return null; // not enough data for a weekly rollup

    try {
      const dailyTexts = dailies.map(d => {
        const dStr = new Date(d.dateRange.start).toISOString().split('T')[0];
        return `## ${dStr}\n${d.content}`;
      }).join('\n\n');

      const summary = await claudeChat({
        system: `You are Alfred synthesizing your weekly review. In 300-500 words, identify:
- Trends and recurring patterns across the week
- Progress and blockers per project
- Revenue trajectory and key metrics changes
- Team performance patterns (who delivered, who struggled)
- Unresolved issues carrying into next week
Be strategic — this is your weekly briefing for Bruce.`,
        messages: [{ role: 'user', content: `Daily summaries for the week:\n\n${dailyTexts}` }],
        timeoutMs: 60_000,
        retries: 1,
      });

      const mem = await this.store({
        userId,
        content: summary,
        source: 'weekly_summary',
        granularity: 'week',
        dateRange: { start: weekStart, end: weekEnd },
        importance: 8,
      });

      // Link daily summaries to this parent
      const dailyIds = dailies.map(d => d._id);
      await MemoryEntry.updateMany(
        { _id: { $in: dailyIds } },
        { $set: { parentMemoryId: mem._id } }
      );

      return mem;
    } catch (err: any) {
      console.log(`[Memory] Weekly summary failed: ${err.message}`);
      return null;
    }
  }

  /** Get memory stats for debugging/API */
  async getStats(userId: string): Promise<{
    total: number;
    bySource: Record<string, number>;
    byGranularity: Record<string, number>;
    oldestDate: Date | null;
    newestDate: Date | null;
  }> {
    const all = await MemoryEntry.find({ userId }).select('source granularity createdAt').lean();

    const bySource: Record<string, number> = {};
    const byGranularity: Record<string, number> = {};

    for (const m of all) {
      bySource[m.source] = (bySource[m.source] || 0) + 1;
      byGranularity[m.granularity] = (byGranularity[m.granularity] || 0) + 1;
    }

    return {
      total: all.length,
      bySource,
      byGranularity,
      oldestDate: all.length > 0 ? all[all.length - 1].createdAt : null,
      newestDate: all.length > 0 ? all[0].createdAt : null,
    };
  }
  /** Delete all memory entries for a user */
  async deleteAll(userId: string): Promise<number> {
    const result = await MemoryEntry.deleteMany({ userId });
    return result.deletedCount || 0;
  }
}

export const memoryService = new MemoryService();
