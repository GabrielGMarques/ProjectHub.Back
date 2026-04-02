import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IProject } from '../models/project.model';
import { AIModel } from './ai.service';
import { claudeChat, getLastUsage } from './claude-proxy.service';
import { TokenUsageService } from './token-usage.service';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MODEL_IDS: Record<AIModel, string> = {
  'claude-sonnet': 'claude-sonnet-4-20250514',
  'gpt-4o': 'gpt-4o',
  'gemini-2.5-flash': 'gemini-2.5-flash',
};

export class StrategicChatService {
  private openai: OpenAI | null = null;
  private gemini: GoogleGenerativeAI | null = null;
  private tokenUsageService = new TokenUsageService();

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    if (process.env.GEMINI_API_KEY) {
      this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
  }

  get isConfigured(): boolean {
    return true; // Claude always available via subscription
  }

  async chat(projects: IProject[], messages: ChatMessage[], model: AIModel = 'claude-sonnet', userId?: string): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(projects);
    switch (model) {
      case 'claude-sonnet': return this.callClaude(systemPrompt, messages, userId);
      case 'gpt-4o': return this.callOpenAI(systemPrompt, messages, userId);
      case 'gemini-2.5-flash': return this.callGemini(systemPrompt, messages, userId);
      default: throw new Error(`Unknown model: ${model}`);
    }
  }

  private async callClaude(systemPrompt: string, messages: ChatMessage[], userId?: string): Promise<string> {
    const result = await claudeChat({
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const usage = getLastUsage();
    if (usage && userId) {
      this.tokenUsageService.record({
        userId, source: 'strategic-chat', aiModel: usage.model,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd, durationMs: usage.durationMs, numTurns: usage.numTurns,
      });
    }

    return result;
  }

  private async callOpenAI(systemPrompt: string, messages: ChatMessage[], userId?: string): Promise<string> {
    if (!this.openai) throw new Error('GPT is not configured. Set OPENAI_API_KEY.');
    const response = await this.openai.chat.completions.create({
      model: MODEL_IDS['gpt-4o'],
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
    });

    if (response.usage && userId) {
      this.tokenUsageService.record({
        userId, source: 'strategic-chat', aiModel: response.model || 'gpt-4o',
        inputTokens: response.usage.prompt_tokens || 0,
        outputTokens: response.usage.completion_tokens || 0,
      });
    }

    return response.choices[0]?.message?.content || '';
  }

  private async callGemini(systemPrompt: string, messages: ChatMessage[], userId?: string): Promise<string> {
    if (!this.gemini) throw new Error('Gemini is not configured. Set GEMINI_API_KEY.');
    const model = this.gemini.getGenerativeModel({
      model: MODEL_IDS['gemini-2.5-flash'],
      systemInstruction: systemPrompt,
    });
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: m.content }],
    }));
    const chat = model.startChat({ history });
    const lastMessage = messages[messages.length - 1];
    const result = await chat.sendMessage(lastMessage.content);

    const meta = result.response.usageMetadata;
    if (meta && userId) {
      this.tokenUsageService.record({
        userId, source: 'strategic-chat', aiModel: 'gemini-2.5-flash',
        inputTokens: meta.promptTokenCount || 0,
        outputTokens: meta.candidatesTokenCount || 0,
      });
    }

    return result.response.text();
  }

  private buildSystemPrompt(projects: IProject[]): string {
    const formatTodos = (todos: any[], indent = 0): string => {
      if (!todos?.length) return '';
      return todos.map(t => {
        const prefix = '  '.repeat(indent) + (t.done ? '[x]' : '[ ]');
        const children = t.children?.length ? '\n' + formatTodos(t.children, indent + 1) : '';
        return `${prefix} ${t.text}${children}`;
      }).join('\n');
    };

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    const projectSummaries = projects.map((p, i) => {
      const weeklyHours = days.reduce((sum, d) => sum + ((p.schedule as any)?.[d] || 0), 0);
      const weeklySpent = days.reduce((sum, d) => sum + ((p.timeSpentPerDay as any)?.[d] || 0), 0);
      const totalTodos = this.countTodos(p.todos || []);
      const doneTodos = this.countDone(p.todos || []);

      let summary = `### Project ${i + 1}: ${p.name} (ID: ${p._id})
- Description: ${p.description || 'N/A'}
- Niche: ${p.niche || 'N/A'}
- MRR: $${p.mrr || 0}
- Clients: ${p.clientCount || 0}
- Impact: ${p.impact || 'low'}
- Weekly Hours (allocated): ${weeklyHours}h
- Weekly Hours (spent): ${weeklySpent}h
- Todos: ${doneTodos}/${totalTodos} done
- Folders: ${(p.folders || []).length > 0 ? (p.folders || []).join(', ') : (p.localPath || 'None')}
- Has Agent Sessions: ${(p.agentSessions || []).length > 0 ? 'Yes' : 'No'}`;

      if (p.monetizationPlan) summary += `\n- Monetization Plan: ${p.monetizationPlan}`;

      if ((p.applications || []).length > 0) {
        const appsWithTests = p.applications.filter(a => a.testInstructions).length;
        summary += `\n- Applications: ${p.applications.length} total, ${appsWithTests} with test instructions`;
      }

      if (p.todos?.length) {
        summary += `\n- Todo List:\n${formatTodos(p.todos)}`;
      }

      if (p.marketingResearch?.marketingPlan?.summary) {
        summary += `\n- Marketing Plan: ${p.marketingResearch.marketingPlan.summary}`;
      }

      return summary;
    }).join('\n\n');

    const totalMrr = projects.reduce((s, p) => s + (p.mrr || 0), 0);
    const totalClients = projects.reduce((s, p) => s + (p.clientCount || 0), 0);
    const totalWeeklyHours = projects.reduce((s, p) => s + days.reduce((ds, d) => ds + ((p.schedule as any)?.[d] || 0), 0), 0);

    return `You are a Strategic Advisor for ProjectsHub — a high-level AI that helps the user manage their entire project portfolio. You have full context on ALL projects and can help prioritize, reallocate time, manage todos, create new projects, and spawn Claude Code agents.

PORTFOLIO OVERVIEW:
- Total Projects: ${projects.length}
- Total MRR: $${totalMrr}
- Total Clients: ${totalClients}
- Total Weekly Hours: ${totalWeeklyHours}h

${projectSummaries}

ACTIONS:
You can suggest concrete changes by including action blocks in your response. Use this exact format:

\`\`\`strategic-action
{"type": "add_todos", "projectId": "<project_id>", "items": ["Task 1", "Task 2"]}
\`\`\`

\`\`\`strategic-action
{"type": "update_field", "projectId": "<project_id>", "field": "description", "value": "New value"}
\`\`\`

\`\`\`strategic-action
{"type": "create_project", "projectName": "New Project Name", "value": "Project description"}
\`\`\`

\`\`\`strategic-action
{"type": "run_agent", "projectId": "<project_id>", "prompt": "The task for the agent to execute"}
\`\`\`

\`\`\`strategic-action
{"type": "prioritize", "projectIds": ["id1", "id2", "id3"]}
\`\`\`

Available action types:
- add_todos: Add items to a specific project's TODO list. Requires "projectId" and "items" array.
- update_field: Update a project field. Requires "projectId", "field" (description, niche, monetizationPlan, impact, mrr, clientCount), and "value".
- create_project: Create a new project. Requires "projectName" and optionally "value" (description).
- run_agent: Spawn a Claude Code agent for a project. Requires "projectId" and "prompt". The project MUST have a folders set.
- prioritize: Reorder projects by importance. Requires "projectIds" array in priority order.

RULES:
- You are a strategic advisor — think about ROI, time allocation, priorities, bottlenecks.
- Reference specific projects by name when making recommendations.
- Only suggest actions when making concrete recommendations or when the user asks.
- Always explain your reasoning BEFORE action blocks.
- The user sees Apply/Dismiss buttons for each action.
- For run_agent: only suggest for projects with folders set. Include a clear, actionable prompt.
- Be concise but thorough. Focus on what will move the needle most.`;
  }

  private countTodos(todos: any[]): number {
    let count = 0;
    for (const t of todos) { count++; if (t.children?.length) count += this.countTodos(t.children); }
    return count;
  }

  private countDone(todos: any[]): number {
    let count = 0;
    for (const t of todos) { if (t.done) count++; if (t.children?.length) count += this.countDone(t.children); }
    return count;
  }
}
