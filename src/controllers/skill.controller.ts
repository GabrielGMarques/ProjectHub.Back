import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { SkillService } from '../services/skill.service';
import { ProjectService } from '../services/project.service';
import { AIService, AIModel } from '../services/ai.service';
import { ClaudeCodeService } from '../services/claude-code.service';

import { TelemetryService } from '../services/telemetry.service';
const skillService = new SkillService();
const projectService = new ProjectService();
const aiService = new AIService();
const claudeCodeService = new ClaudeCodeService();
const telemetryService = new TelemetryService();

export class SkillController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      await skillService.seedBuiltInSkills(req.userId!);
      const projectId = req.query.projectId as string | undefined;
      const skills = await skillService.findAllForUser(req.userId!, projectId);
      res.json(skills);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch skills' });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const skill = await skillService.create(req.userId!, req.body);
      res.status(201).json(skill);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create skill' });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      const skill = await skillService.update(req.params.id, req.userId!, req.body);
      if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
      res.json(skill);
    } catch (error) {
      res.status(500).json({ error: 'Failed to update skill' });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const skill = await skillService.delete(req.params.id, req.userId!);
      if (!skill) { res.status(404).json({ error: 'Skill not found or is built-in' }); return; }
      res.json({ message: 'Skill deleted' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete skill' });
    }
  }

  async execute(req: AuthRequest, res: Response): Promise<void> {
    const skill = await skillService.findById(req.params.id, req.userId!);
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }

    const project = await projectService.findById(req.params.projectId, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const model = (req.body.model || 'claude-sonnet') as AIModel;

    if (skill.executionMode === 'ai-chat') {
      if (!aiService.isConfigured) {
        res.status(503).json({ error: 'No AI provider configured' });
        return;
      }
      try {
        const response = await aiService.coach(
          project,
          [{ role: 'user', content: skill.prompt }],
          model
        );
        res.json({ response, mode: 'ai-chat' });
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Skill execution failed' });
      }
    } else {
      // claude-code mode: SSE stream
      const skillCwd = (project.folders || [])[0] || project.localPath;
      if (!skillCwd) {
        res.status(400).json({ error: 'Project has no folders configured' });
        return;
      }
      const availability = await claudeCodeService.checkAvailability();
      if (!availability.available) {
        res.status(503).json({ error: 'Claude Code CLI is not available' });
        return;
      }

      // Prepend project presentation as context if available
      let skillPrompt = skill.prompt;
      if (project.presentation) {
        skillPrompt = `[PROJECT PRESENTATION]\n${project.presentation}\n[END PROJECT PRESENTATION]\n\nUse the project presentation above as context. Now handle this request:\n${skill.prompt}`;
      }

      req.setTimeout(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const startTime = Date.now();
      telemetryService.track({
        userId: req.userId!, projectId: req.params.projectId,
        type: 'agent_run', source: `skill:${skill.name}`, status: 'started',
        description: skill.prompt.substring(0, 200),
      });

      try {
        const result = await claudeCodeService.runCommand(skillCwd, skillPrompt, (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        telemetryService.track({
          userId: req.userId!, projectId: req.params.projectId,
          type: 'agent_run', source: `skill:${skill.name}`,
          status: result.status === 'completed' ? 'completed' : 'failed',
          description: skill.prompt.substring(0, 200),
          durationMs: Date.now() - startTime,
        });
      } catch (error: any) {
        telemetryService.track({
          userId: req.userId!, projectId: req.params.projectId,
          type: 'error', source: `skill:${skill.name}`, status: 'failed',
          description: skill.prompt.substring(0, 200),
          error: error.message, durationMs: Date.now() - startTime,
        });
        res.write(`data: ${JSON.stringify({ type: 'error', content: error.message, sessionId: '', timestamp: new Date() })}\n\n`);
      }
      res.end();
    }
  }
}
