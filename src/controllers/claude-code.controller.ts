import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ProjectService } from '../services/project.service';
import { ClaudeCodeService } from '../services/claude-code.service';

const projectService = new ProjectService();
const claudeCodeService = new ClaudeCodeService();

export class ClaudeCodeController {
  async getStatus(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = await claudeCodeService.checkAvailability();
      res.json(status);
    } catch {
      res.json({ available: false, version: '' });
    }
  }

  async runAgent(req: AuthRequest, res: Response): Promise<void> {
    const project = await projectService.findById(req.params.id, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const projectPath = project.localPath;
    if (!projectPath) {
      res.status(400).json({ error: 'Project has no local path configured. Set localPath in project settings.' });
      return;
    }

    const availability = await claudeCodeService.checkAvailability();
    if (!availability.available) {
      res.status(503).json({ error: 'Claude Code CLI is not available on this machine.' });
      return;
    }

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    // Prepend project presentation as context if available
    let fullPrompt = prompt;
    if (project.presentation) {
      fullPrompt = `[PROJECT PRESENTATION]\n${project.presentation}\n[END PROJECT PRESENTATION]\n\nUse the project presentation above as context. Now handle this request:\n${prompt}`;
    }

    // SSE setup — disable Node request timeout for long-running agent sessions
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      await claudeCodeService.runCommand(projectPath, fullPrompt, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch (error: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: error.message, sessionId: '', timestamp: new Date() })}\n\n`);
    }
    res.end();
  }

  async cancelAgent(req: AuthRequest, res: Response): Promise<void> {
    const { sessionId } = req.body;
    if (!sessionId) { res.status(400).json({ error: 'sessionId is required' }); return; }
    claudeCodeService.cancelSession(sessionId);
    res.json({ message: 'Session cancelled' });
  }
}
