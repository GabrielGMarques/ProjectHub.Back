import { AIService, AIModel } from './ai.service';
import {
  IProject,
  ICompetitor,
  IMarketingChannel,
  IMarketingActionItem,
  IMarketingResearch,
} from '../models/project.model';

interface StepEvent {
  name: string;
  status: 'running' | 'completed' | 'failed';
  result?: any;
}

type OnStepCallback = (step: StepEvent) => void;

interface MarketSizeResult {
  tam: string;
  sam: string;
  som: string;
  sources: string[];
}

interface TrendResult {
  title: string;
  description: string;
  relevance: 'low' | 'medium' | 'high';
  source: string;
}

interface BenchmarksResult {
  raw: string;
}

interface MarketingPlanResult {
  summary: string;
  channels: IMarketingChannel[];
  actionItems: IMarketingActionItem[];
  raw: string;
}

export class MarketingResearchService {
  constructor(private aiService: AIService) {}

  /**
   * Runs the full 5-step marketing research pipeline sequentially.
   * Each step feeds into the next. Calls onStep for SSE streaming.
   */
  async runFullResearch(
    project: IProject,
    model: AIModel = 'claude-sonnet',
    onStep?: OnStepCallback,
  ): Promise<IMarketingResearch> {
    // Step 1: Competitor Analysis
    onStep?.({ name: 'competitors', status: 'running' });
    let competitors: ICompetitor[];
    try {
      competitors = await this.analyzeCompetitors(project, model);
      onStep?.({ name: 'competitors', status: 'completed', result: competitors });
    } catch (err) {
      onStep?.({ name: 'competitors', status: 'failed', result: String(err) });
      competitors = [];
    }

    // Step 2: Market Size
    onStep?.({ name: 'market-size', status: 'running' });
    let marketSize: MarketSizeResult;
    try {
      marketSize = await this.analyzeMarketSize(project, model);
      onStep?.({ name: 'market-size', status: 'completed', result: marketSize });
    } catch (err) {
      onStep?.({ name: 'market-size', status: 'failed', result: String(err) });
      marketSize = { tam: '', sam: '', som: '', sources: [] };
    }

    // Step 3: Trend Analysis
    onStep?.({ name: 'trends', status: 'running' });
    let trends: TrendResult[];
    try {
      trends = await this.analyzeTrends(project, model);
      onStep?.({ name: 'trends', status: 'completed', result: trends });
    } catch (err) {
      onStep?.({ name: 'trends', status: 'failed', result: String(err) });
      trends = [];
    }

    // Step 4: Benchmarks (uses competitor data from step 1)
    onStep?.({ name: 'benchmarks', status: 'running' });
    let benchmarks: BenchmarksResult;
    try {
      benchmarks = await this.analyzeBenchmarks(project, model, competitors);
      onStep?.({ name: 'benchmarks', status: 'completed', result: benchmarks });
    } catch (err) {
      onStep?.({ name: 'benchmarks', status: 'failed', result: String(err) });
      benchmarks = { raw: '' };
    }

    // Step 5: Marketing Plan (uses all prior outputs)
    onStep?.({ name: 'plan', status: 'running' });
    let marketingPlan: MarketingPlanResult;
    try {
      marketingPlan = await this.generateMarketingPlan(
        project, model, { competitors, marketSize, trends, benchmarks },
      );
      onStep?.({ name: 'plan', status: 'completed', result: marketingPlan });
    } catch (err) {
      onStep?.({ name: 'plan', status: 'failed', result: String(err) });
      marketingPlan = { summary: '', channels: [], actionItems: [], raw: '' };
    }

    return {
      competitors,
      marketSize: { ...marketSize, analyzedAt: new Date() },
      trends,
      benchmarks: { ...benchmarks, analyzedAt: new Date() },
      marketingPlan: { ...marketingPlan, generatedAt: new Date() },
      lastResearchAt: new Date(),
    };
  }

  async runSingleStep(project: IProject, step: string, model: AIModel): Promise<Partial<IMarketingResearch>> {
    switch (step) {
      case 'competitors':
        return { competitors: await this.analyzeCompetitors(project, model) };
      case 'market-size':
        return { marketSize: { ...await this.analyzeMarketSize(project, model), analyzedAt: new Date() } };
      case 'trends':
        return { trends: await this.analyzeTrends(project, model) };
      case 'benchmarks':
        return { benchmarks: { ...await this.analyzeBenchmarks(project, model, []), analyzedAt: new Date() } };
      case 'plan':
        return { marketingPlan: { ...await this.generateMarketingPlan(project, model), generatedAt: new Date() } };
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  }

  // --- Individual step methods ---

  async analyzeCompetitors(project: IProject, model: AIModel): Promise<ICompetitor[]> {
    const prompt = `Analyze the competitive landscape for this project. Identify 3-5 key competitors.

Return ONLY a JSON block in a code fence with this structure:
\`\`\`json
[
  {
    "name": "Competitor Name",
    "url": "https://example.com",
    "strengths": ["strength1", "strength2"],
    "weaknesses": ["weakness1", "weakness2"],
    "estimatedMrr": 10000,
    "notes": "Brief notes about positioning"
  }
]
\`\`\`

Focus on the project's niche ("${project.niche || project.description}") and its current MRR of $${project.mrr || 0}. Be specific and realistic.`;

    const raw = await this.ask(project, prompt, model);
    const parsed = this.parseJson<ICompetitor[]>(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  async analyzeMarketSize(project: IProject, model: AIModel): Promise<MarketSizeResult> {
    const prompt = `Estimate the market size for this project's niche.

Return ONLY a JSON block in a code fence:
\`\`\`json
{
  "tam": "Total Addressable Market estimate with explanation",
  "sam": "Serviceable Addressable Market estimate with explanation",
  "som": "Serviceable Obtainable Market estimate with explanation",
  "sources": ["source1", "source2"]
}
\`\`\`

Base your analysis on the niche "${project.niche || 'general'}" and description "${project.description}". Provide realistic estimates with reasoning.`;

    const raw = await this.ask(project, prompt, model);
    const parsed = this.parseJson<MarketSizeResult>(raw);
    return parsed && parsed.tam
      ? parsed
      : { tam: raw, sam: '', som: '', sources: [] };
  }

  async analyzeTrends(project: IProject, model: AIModel): Promise<TrendResult[]> {
    const prompt = `Identify 4-6 current market trends relevant to this project.

Return ONLY a JSON block in a code fence:
\`\`\`json
[
  {
    "title": "Trend Title",
    "description": "Detailed description of the trend and its implications",
    "relevance": "high",
    "source": "Industry report or known data source"
  }
]
\`\`\`

Relevance must be "low", "medium", or "high". Focus on trends in the "${project.niche || 'tech'}" space.`;

    const raw = await this.ask(project, prompt, model);
    const parsed = this.parseJson<TrendResult[]>(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  async analyzeBenchmarks(
    project: IProject,
    model: AIModel,
    competitors?: ICompetitor[],
  ): Promise<BenchmarksResult> {
    const competitorContext = competitors?.length
      ? `\n\nKnown competitors:\n${competitors.map(c => `- ${c.name} (est. MRR: $${c.estimatedMrr}): strengths: ${c.strengths.join(', ')}`).join('\n')}`
      : '';

    const prompt = `Create a competitive benchmark analysis for this project.${competitorContext}

Compare the project's current metrics (MRR: $${project.mrr || 0}, clients: ${project.clientCount || 0}) against industry benchmarks and the competitors above.

Return ONLY a JSON block in a code fence:
\`\`\`json
{
  "raw": "Full benchmark analysis as a detailed markdown string covering: pricing comparison, feature gaps, growth rate benchmarks, and key metrics to track"
}
\`\`\``;

    const raw = await this.ask(project, prompt, model);
    const parsed = this.parseJson<BenchmarksResult>(raw);
    return parsed && parsed.raw ? parsed : { raw };
  }

  async generateMarketingPlan(
    project: IProject,
    model: AIModel,
    priorResearch?: {
      competitors?: ICompetitor[];
      marketSize?: MarketSizeResult;
      trends?: TrendResult[];
      benchmarks?: BenchmarksResult;
    },
  ): Promise<MarketingPlanResult> {
    let context = '';
    if (priorResearch) {
      const { competitors, marketSize, trends, benchmarks } = priorResearch;
      if (competitors?.length) {
        context += `\nCOMPETITORS:\n${competitors.map(c => `- ${c.name}: ${c.notes}`).join('\n')}`;
      }
      if (marketSize?.tam) {
        context += `\nMARKET SIZE:\n- TAM: ${marketSize.tam}\n- SAM: ${marketSize.sam}\n- SOM: ${marketSize.som}`;
      }
      if (trends?.length) {
        context += `\nTRENDS:\n${trends.map(t => `- ${t.title} (${t.relevance}): ${t.description}`).join('\n')}`;
      }
      if (benchmarks?.raw) {
        context += `\nBENCHMARKS:\n${benchmarks.raw.substring(0, 1000)}`;
      }
    }

    const prompt = `Create a comprehensive marketing plan for this project.
${context}

Return ONLY a JSON block in a code fence:
\`\`\`json
{
  "summary": "2-3 sentence executive summary of the marketing strategy",
  "channels": [
    {
      "name": "Channel Name",
      "strategy": "Specific strategy for this channel",
      "budget": "$X/month",
      "expectedRoi": "Expected return description",
      "priority": "high",
      "status": "planned"
    }
  ],
  "actionItems": [
    {
      "task": "Specific actionable task",
      "channel": "Related channel name",
      "deadline": "YYYY-MM-DD",
      "done": false
    }
  ],
  "raw": "Full detailed marketing plan as markdown"
}
\`\`\`

Priority must be "low", "medium", or "high". Status must be "planned", "in-progress", or "completed". Provide 3-5 channels and 5-10 action items. Be specific and actionable given the project's current stage (MRR: $${project.mrr || 0}, ${project.clientCount || 0} clients).`;

    const raw = await this.ask(project, prompt, model);
    const parsed = this.parseJson<MarketingPlanResult>(raw);
    return parsed && parsed.summary
      ? parsed
      : { summary: '', channels: [], actionItems: [], raw };
  }

  // --- Helpers ---

  private async ask(project: IProject, prompt: string, model: AIModel): Promise<string> {
    return this.aiService.coach(
      project,
      [{ role: 'user', content: prompt }],
      model,
    );
  }

  private parseJson<T>(text: string): T | null {
    // Try to extract JSON from a code fence first
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();

    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Try to find any JSON array or object in the text
      const bracketMatch = jsonStr.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      if (bracketMatch) {
        try {
          return JSON.parse(bracketMatch[1]) as T;
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
