import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ProjectService } from '../services/project.service';
import { MarketingResearchService } from '../services/marketing-research.service';
import { AIService, AIModel } from '../services/ai.service';

const projectService = new ProjectService();
const aiService = new AIService();
const researchService = new MarketingResearchService(aiService);

export class MarketingResearchController {
  async runFullResearch(req: AuthRequest, res: Response): Promise<void> {
    const project = await projectService.findById(req.params.id, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!aiService.isConfigured) { res.status(503).json({ error: 'No AI provider configured' }); return; }

    const model = (req.body.model || 'claude-sonnet') as AIModel;

    // SSE setup — disable request timeout for long-running research
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      const result = await researchService.runFullResearch(project, model, (step) => {
        res.write(`data: ${JSON.stringify(step)}\n\n`);
      });

      // Save to project
      await projectService.update(req.params.id, req.userId!, {
        marketingResearch: result,
      });

      res.write(`data: ${JSON.stringify({ type: 'done', result })}\n\n`);
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }
    res.end();
  }

  async runStep(req: AuthRequest, res: Response): Promise<void> {
    const project = await projectService.findById(req.params.id, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!aiService.isConfigured) { res.status(503).json({ error: 'No AI provider configured' }); return; }

    const { step } = req.params;
    const model = (req.body.model || 'claude-sonnet') as AIModel;
    const validSteps = ['competitors', 'market-size', 'trends', 'benchmarks', 'plan'];
    if (!validSteps.includes(step)) {
      res.status(400).json({ error: `Invalid step. Must be one of: ${validSteps.join(', ')}` });
      return;
    }

    try {
      const result = await researchService.runSingleStep(project, step, model);
      // Merge result into existing research
      const existing = project.marketingResearch || {} as any;
      const updated = { ...existing, ...result, lastResearchAt: new Date() };
      await projectService.update(req.params.id, req.userId!, { marketingResearch: updated });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Research step failed' });
    }
  }

  async getLatest(req: AuthRequest, res: Response): Promise<void> {
    const project = await projectService.findById(req.params.id, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(project.marketingResearch || {});
  }
}
