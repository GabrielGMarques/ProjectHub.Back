import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { IProject } from '../models/project.model';

let pdfParse: any;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null;
}

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AIModel =
  | 'claude-sonnet'
  | 'gpt-4o'
  | 'gemini-2.5-flash';

const MODEL_IDS: Record<AIModel, string> = {
  'claude-sonnet': 'claude-sonnet-4-20250514',
  'gpt-4o': 'gpt-4o',
  'gemini-2.5-flash': 'gemini-2.5-flash',
};

export class AIService {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private gemini: GoogleGenerativeAI | null = null;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    if (process.env.GEMINI_API_KEY) {
      this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
  }

  get isConfigured(): boolean {
    return this.anthropic !== null || this.openai !== null || this.gemini !== null;
  }

  getAvailableModels(): { id: AIModel; name: string; available: boolean }[] {
    return [
      { id: 'claude-sonnet', name: 'Claude Sonnet', available: this.anthropic !== null },
      { id: 'gpt-4o', name: 'GPT-4o', available: this.openai !== null },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', available: this.gemini !== null },
    ];
  }

  async coach(project: IProject, messages: ChatMessage[], model: AIModel = 'claude-sonnet'): Promise<string> {
    const docTexts = await this.extractDocumentTexts(project);
    const systemPrompt = this.buildSystemPrompt(project, docTexts);

    switch (model) {
      case 'claude-sonnet':
        return this.callClaude(systemPrompt, messages);
      case 'gpt-4o':
        return this.callOpenAI(systemPrompt, messages);
      case 'gemini-2.5-flash':
        return this.callGemini(systemPrompt, messages);
      default:
        throw new Error(`Unknown model: ${model}`);
    }
  }

  private async callClaude(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    if (!this.anthropic) {
      throw new Error('Claude is not configured. Set ANTHROPIC_API_KEY in your environment.');
    }
    const response = await this.anthropic.messages.create({
      model: MODEL_IDS['claude-sonnet'],
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }

  private async callOpenAI(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    if (!this.openai) {
      throw new Error('GPT is not configured. Set OPENAI_API_KEY in your environment.');
    }
    const response = await this.openai.chat.completions.create({
      model: MODEL_IDS['gpt-4o'],
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
    });
    return response.choices[0]?.message?.content || '';
  }

  private async callGemini(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    if (!this.gemini) {
      throw new Error('Gemini is not configured. Set GEMINI_API_KEY in your environment.');
    }
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
    return result.response.text();
  }

  private buildSystemPrompt(project: IProject, docTexts: string[]): string {
    const todos = project.todos?.map(t => `  - [${t.done ? 'x' : ' '}] ${t.text}`).join('\n') || 'None';
    const schedule = project.schedule
      ? `Mon: ${project.schedule.monday}h, Tue: ${project.schedule.tuesday}h, Wed: ${project.schedule.wednesday}h, Thu: ${project.schedule.thursday}h, Fri: ${project.schedule.friday}h, Sat: ${project.schedule.saturday}h, Sun: ${project.schedule.sunday}h`
      : 'Not set';

    let prompt = `You are an AI project coach for ProjectsHub. You help project owners grow their projects and achieve their goals. Provide actionable, specific advice. Be concise but thorough.

PROJECT DETAILS:
- Name: ${project.name}
- Description: ${project.description || 'N/A'}
- Niche: ${project.niche || 'N/A'}
- MRR: $${project.mrr || 0}
- Clients: ${project.clientCount || 0}
- Impact: ${project.impact || 'N/A'}
- Hours/Week: ${project.timeConsumption || 0}h
- Schedule: ${schedule}

TODO LIST:
${todos}

MONETIZATION PLAN:
${project.monetizationPlan || 'Not set'}`;

    if (project.presentation) {
      prompt += `\n\nPROJECT PRESENTATION:\n${project.presentation}`;
    }

    if (docTexts.length > 0) {
      prompt += '\n\nATTACHED DOCUMENTS:\n';
      prompt += docTexts.join('\n\n');
    }

    prompt += '\n\nUse the above context to provide relevant, actionable coaching advice. Reference specific details from the project and documents when applicable.';

    return prompt;
  }

  private async extractDocumentTexts(project: IProject): Promise<string[]> {
    const texts: string[] = [];
    if (!project.documents?.length) return texts;

    for (const doc of project.documents) {
      const filePath = path.join(UPLOADS_DIR, doc.filename);
      if (!fs.existsSync(filePath)) continue;

      try {
        if (doc.mimeType === 'application/pdf' && pdfParse) {
          const buffer = fs.readFileSync(filePath);
          const data = await pdfParse(buffer);
          texts.push(`--- Document: ${doc.originalName} ---\n${data.text.substring(0, 10000)}`);
        } else if (doc.mimeType.startsWith('text/') || [
          'application/json', 'application/xml', 'application/javascript',
          'application/typescript', 'application/x-yaml',
        ].includes(doc.mimeType)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          texts.push(`--- Document: ${doc.originalName} ---\n${content.substring(0, 10000)}`);
        } else {
          texts.push(`--- Document: ${doc.originalName} (${doc.mimeType}, ${(doc.size / 1024).toFixed(1)}KB) ---\n[Binary file - content not extractable]`);
        }
      } catch {
        texts.push(`--- Document: ${doc.originalName} ---\n[Failed to extract content]`);
      }
    }

    return texts;
  }
}
