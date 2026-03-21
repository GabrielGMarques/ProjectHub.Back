import Anthropic from '@anthropic-ai/sdk';
import { EmployeeMemory, IEmployeeMemory } from '../models/employee-memory.model';
import { EmployeeLog } from '../models/employee-log.model';
import { Employee } from '../models/employee.model';
import { Types } from 'mongoose';

const MAX_MEMORIES_PER_EMPLOYEE = 50;
const COMPACTION_BATCH_SIZE = 100;

export class EmployeeMemoryService {
  private anthropic: Anthropic | null = null;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  }

  /** Get all memories for an employee, sorted by importance */
  async getMemories(employeeId: string, category?: string, limit = 50): Promise<any[]> {
    const filter: any = { employeeId: new Types.ObjectId(employeeId) };
    if (category) filter.category = category;
    return EmployeeMemory.find(filter).sort({ importance: -1, createdAt: -1 }).limit(limit).lean();
  }

  /** Build a compact context string from employee memories for prompt injection */
  async buildMemoryContext(employeeId: string): Promise<string> {
    const memories = await EmployeeMemory.find({ employeeId: new Types.ObjectId(employeeId) })
      .sort({ importance: -1, createdAt: -1 })
      .limit(30)
      .lean();

    if (!memories.length) return '';

    // Mark as accessed
    const ids = memories.map(m => m._id);
    await EmployeeMemory.updateMany({ _id: { $in: ids } }, { $inc: { accessCount: 1 }, lastAccessedAt: new Date() });

    const grouped: Record<string, string[]> = {};
    for (const m of memories) {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category].push(`- ${m.content}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}`);
    }

    let ctx = '\n=== YOUR MEMORY (from previous tasks) ===\n';
    const order: string[] = ['goal', 'learning', 'blocker', 'decision', 'preference', 'context'];
    const labels: Record<string, string> = {
      goal: 'GOALS & OBJECTIVES',
      learning: 'LEARNINGS & INSIGHTS',
      blocker: 'KNOWN BLOCKERS & ISSUES',
      decision: 'DECISIONS MADE',
      preference: 'PREFERENCES & PATTERNS',
      context: 'PROJECT CONTEXT',
    };

    for (const cat of order) {
      if (grouped[cat]?.length) {
        ctx += `\n${labels[cat]}:\n${grouped[cat].join('\n')}\n`;
      }
    }

    ctx += '\nUse this memory to avoid repeating past mistakes and to build on previous work. If any memory is outdated, note it in your response.\n';
    return ctx;
  }

  /** Compact recent logs into memory entries using Claude */
  async compactLogs(userId: string, employeeId: string): Promise<{ created: number; summary: string }> {
    if (!this.anthropic) throw new Error('ANTHROPIC_API_KEY not configured');

    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    // Get recent logs that haven't been compacted yet
    const lastMemory = await EmployeeMemory.findOne({ employeeId: new Types.ObjectId(employeeId) })
      .sort({ createdAt: -1 }).lean();

    const logFilter: any = {
      employeeId: new Types.ObjectId(employeeId),
      category: { $in: ['task_start', 'task_complete', 'task_fail', 'tool_use', 'text', 'error'] },
    };
    if (lastMemory) {
      logFilter.createdAt = { $gt: lastMemory.createdAt };
    }

    const logs = await EmployeeLog.find(logFilter)
      .sort({ createdAt: 1 })
      .limit(COMPACTION_BATCH_SIZE)
      .lean();

    if (logs.length < 5) {
      return { created: 0, summary: 'Not enough new logs to compact' };
    }

    // Build a compact log summary for Claude to analyze
    const logText = logs.map(l => {
      const time = new Date(l.createdAt).toISOString().substring(11, 19);
      return `[${time}] ${l.category}: ${l.content.substring(0, 300)}`;
    }).join('\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: `You extract structured memories from employee execution logs. Output ONLY valid JSON — no markdown, no explanation.

Each memory must have:
- category: one of "goal", "learning", "blocker", "decision", "preference", "context"
- content: concise 1-2 sentence summary of the insight
- importance: 0-10 (10 = critical, 5 = normal, 1 = trivial)
- tags: array of relevant keywords

Rules:
- Focus on LEARNINGS: what worked, what failed, what patterns emerged
- Track BLOCKERS: recurring errors, permission issues, tool limitations
- Note DECISIONS: technology choices, architecture patterns, file structures
- Capture CONTEXT: project structure discoveries, dependencies found, configs learned
- COMPACT aggressively — if 10 logs say "tried npm install", one memory "npm install works in this project" is enough
- Maximum 8 memories per compaction
- Skip routine operations (cd, ls, read file) unless they reveal something unexpected`,
      messages: [{
        role: 'user',
        content: `Employee: ${employee.name} (${employee.title}, role: ${employee.role})
Project: ${employee.projectId}

EXECUTION LOGS (${logs.length} entries):
${logText}

Extract the key memories from these logs. Return JSON array:
[{"category": "...", "content": "...", "importance": N, "tags": ["..."]}]`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    let parsed: any[] = [];
    try {
      // Try to find JSON array in the response
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {
      return { created: 0, summary: 'Failed to parse AI response' };
    }

    if (!Array.isArray(parsed) || !parsed.length) {
      return { created: 0, summary: 'No memories extracted' };
    }

    // Enforce max memories — remove least important if over limit
    const currentCount = await EmployeeMemory.countDocuments({ employeeId: new Types.ObjectId(employeeId) });
    if (currentCount + parsed.length > MAX_MEMORIES_PER_EMPLOYEE) {
      const toRemove = (currentCount + parsed.length) - MAX_MEMORIES_PER_EMPLOYEE;
      const leastImportant = await EmployeeMemory.find({ employeeId: new Types.ObjectId(employeeId) })
        .sort({ importance: 1, accessCount: 1, createdAt: 1 })
        .limit(toRemove)
        .select('_id');
      await EmployeeMemory.deleteMany({ _id: { $in: leastImportant.map(m => m._id) } });
    }

    // Save new memories
    const created: IEmployeeMemory[] = [];
    for (const mem of parsed.slice(0, 8)) {
      const valid = ['goal', 'learning', 'blocker', 'decision', 'preference', 'context'];
      if (!valid.includes(mem.category)) continue;

      const doc = await EmployeeMemory.create({
        userId: new Types.ObjectId(userId),
        employeeId: new Types.ObjectId(employeeId),
        projectId: employee.projectId,
        category: mem.category,
        content: String(mem.content).substring(0, 500),
        importance: Math.min(10, Math.max(0, Number(mem.importance) || 5)),
        tags: Array.isArray(mem.tags) ? mem.tags.map(String).slice(0, 5) : [],
        source: `compaction:${logs.length}logs`,
      });
      created.push(doc);
    }

    return {
      created: created.length,
      summary: `Compacted ${logs.length} logs into ${created.length} memories`,
    };
  }

  /** Add a single memory manually */
  async addMemory(userId: string, employeeId: string, data: {
    category: string; content: string; importance?: number; tags?: string[];
  }): Promise<IEmployeeMemory> {
    const employee = await Employee.findOne({ _id: employeeId, userId });
    if (!employee) throw new Error('Employee not found');

    return EmployeeMemory.create({
      userId: new Types.ObjectId(userId),
      employeeId: new Types.ObjectId(employeeId),
      projectId: employee.projectId,
      category: data.category,
      content: data.content.substring(0, 500),
      importance: data.importance ?? 5,
      tags: data.tags || [],
      source: 'manual',
    });
  }

  /** Delete a single memory */
  async deleteMemory(userId: string, memoryId: string): Promise<void> {
    await EmployeeMemory.deleteOne({ _id: memoryId, userId: new Types.ObjectId(userId) });
  }

  /** Wipe all memories for an employee (fresh start) */
  async wipeMemories(userId: string, employeeId: string): Promise<number> {
    const result = await EmployeeMemory.deleteMany({
      userId: new Types.ObjectId(userId),
      employeeId: new Types.ObjectId(employeeId),
    });
    return result.deletedCount || 0;
  }
}

export const employeeMemoryService = new EmployeeMemoryService();
