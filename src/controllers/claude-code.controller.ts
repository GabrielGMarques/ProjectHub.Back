import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ProjectService } from '../services/project.service';
import { ClaudeCodeService } from '../services/claude-code.service';
import { TelemetryService } from '../services/telemetry.service';
import { Project } from '../models/project.model';

const projectService = new ProjectService();
const claudeCodeService = new ClaudeCodeService();
const telemetryService = new TelemetryService();

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

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const projectPath = allFolders[0];
    if (!projectPath) {
      res.status(400).json({ error: 'Project has no folders configured. Add folders in project settings.' });
      return;
    }

    const availability = await claudeCodeService.checkAvailability();
    if (!availability.available) {
      res.status(503).json({ error: 'Claude Code CLI is not available on this machine.' });
      return;
    }

    const { prompt, resumeSdkSessionId } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    // Build rich project context for the agent (skip on resume — context already in session)
    let fullPrompt = prompt;
    if (!resumeSdkSessionId) {
      const ctx: string[] = [];

      ctx.push(`Project: ${project.name}`);
      if (project.description) ctx.push(`Description: ${project.description}`);
      if (project.niche) ctx.push(`Niche: ${project.niche}`);
      if (allFolders.length) {
        ctx.push(`Working Directory (cwd): ${allFolders[0]}`);
        if (allFolders.length > 1) {
          ctx.push(`Project Folders (you have access to all of these):`);
          allFolders.forEach((p: string) => ctx.push(`  - ${p}`));
        }
      }
      if (project.githubRepos?.length) ctx.push(`GitHub Repos: ${project.githubRepos.join(', ')}`);
      if (project.mrr) ctx.push(`MRR: $${project.mrr}`);
      if (project.clientCount) ctx.push(`Clients: ${project.clientCount}`);
      if (project.impact) ctx.push(`Impact: ${project.impact}`);
      if (project.monetizationPlan) ctx.push(`Monetization Plan: ${project.monetizationPlan}`);

      if (project.presentation) {
        ctx.push(`\n--- Project Presentation ---\n${project.presentation}`);
      }

      // Todos
      const formatTodos = (todos: any[], indent = 0): string => {
        if (!todos?.length) return '';
        return todos.map(t => {
          const prefix = '  '.repeat(indent) + (t.done ? '[x]' : '[ ]');
          const children = t.children?.length ? '\n' + formatTodos(t.children, indent + 1) : '';
          return `${prefix} ${t.text}${children}`;
        }).join('\n');
      };
      if (project.todos?.length) {
        ctx.push(`\n--- Todos ---\n${formatTodos(project.todos)}`);
      }

      // Schedule
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const hasSchedule = days.some(d => (project.schedule as any)?.[d] > 0);
      if (hasSchedule) {
        const sched = days.map(d => `${d}: ${(project.schedule as any)?.[d] || 0}h`).join(', ');
        ctx.push(`Weekly Schedule (allocated): ${sched}`);
      }
      const hasTimeSpent = days.some(d => (project.timeSpentPerDay as any)?.[d] > 0);
      if (hasTimeSpent) {
        const spent = days.map(d => `${d}: ${(project.timeSpentPerDay as any)?.[d] || 0}h`).join(', ');
        ctx.push(`Weekly Time Spent: ${spent}`);
      }

      // Marketing research summary
      if (project.marketingResearch) {
        const mr = project.marketingResearch;
        if (mr.competitors?.length) {
          ctx.push(`\n--- Competitors (${mr.competitors.length}) ---`);
          mr.competitors.forEach(c => ctx.push(`- ${c.name} (${c.url}): Strengths: ${c.strengths?.join(', ')}; Weaknesses: ${c.weaknesses?.join(', ')}`));
        }
        if (mr.marketSize?.tam) {
          ctx.push(`\nMarket Size: TAM=${mr.marketSize.tam}, SAM=${mr.marketSize.sam}, SOM=${mr.marketSize.som}`);
        }
        if (mr.trends?.length) {
          ctx.push(`\n--- Trends ---`);
          mr.trends.forEach(t => ctx.push(`- [${t.relevance}] ${t.title}: ${t.description}`));
        }
        if (mr.marketingPlan?.summary) {
          ctx.push(`\n--- Marketing Plan ---\n${mr.marketingPlan.summary}`);
          if (mr.marketingPlan.channels?.length) {
            ctx.push('Channels:');
            mr.marketingPlan.channels.forEach(ch => ctx.push(`- ${ch.name} (${ch.priority} priority, ${ch.status}): ${ch.strategy}`));
          }
          if (mr.marketingPlan.actionItems?.length) {
            ctx.push('Action Items:');
            mr.marketingPlan.actionItems.forEach(ai => ctx.push(`- ${ai.done ? '[x]' : '[ ]'} ${ai.task} (${ai.channel}, by ${ai.deadline})`));
          }
        }
      }

      if (ctx.length > 1) {
        fullPrompt = `[PROJECT CONTEXT]\n${ctx.join('\n')}\n[END PROJECT CONTEXT]\n\nUse the project context above to inform your work. Now handle this request:\n${prompt}`;
      }
    }

    // SSE setup — disable Node request timeout for long-running agent sessions
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Track sessionId so we can cancel on client disconnect
    let activeSessionId = '';
    let clientDisconnected = false;

    req.on('close', () => {
      clientDisconnected = true;
      if (activeSessionId) {
        claudeCodeService.cancelSession(activeSessionId);
      }
    });

    const startTime = Date.now();
    telemetryService.track({
      userId: req.userId!, projectId: req.params.id,
      type: 'agent_run', source: 'claude-code', status: 'started',
      description: prompt.substring(0, 200),
    });

    try {
      const result = await claudeCodeService.runCommand(
        projectPath,
        fullPrompt,
        (event) => {
          if (event.sessionId) activeSessionId = event.sessionId;
          if (!clientDisconnected && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
        { resumeSdkSessionId },
      );

      telemetryService.track({
        userId: req.userId!, projectId: req.params.id,
        type: 'agent_run', source: 'claude-code',
        status: result.status === 'completed' ? 'completed' : 'failed',
        description: prompt.substring(0, 200),
        durationMs: Date.now() - startTime,
        error: result.status !== 'completed' ? result.status : undefined,
      });

      // Save session to project (fire-and-forget)
      Project.findByIdAndUpdate(req.params.id, {
        $push: {
          agentSessions: {
            sessionId: result.sessionId,
            sdkSessionId: result.sdkSessionId,
            type: 'claude-code',
            status: result.status,
            prompt,
            events: result.events,
            steps: [],
            createdAt: result.events[0]?.timestamp || new Date(),
            completedAt: new Date(),
          },
        },
      }).catch(() => {});
    } catch (error: any) {
      telemetryService.track({
        userId: req.userId!, projectId: req.params.id,
        type: 'error', source: 'claude-code', status: 'failed',
        description: prompt.substring(0, 200),
        error: error.message, durationMs: Date.now() - startTime,
      });
      if (!clientDisconnected && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', content: error.message, sessionId: '', timestamp: new Date() })}\n\n`);
      }
    }
    if (!res.writableEnded) res.end();
  }

  async getSessions(req: AuthRequest, res: Response): Promise<void> {
    const project = await projectService.findById(req.params.id, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    // Return sessions without full events (just metadata) for the list view
    const sessions = (project.agentSessions || [])
      .filter(s => s.type === 'claude-code')
      .map(s => ({
        sessionId: s.sessionId,
        sdkSessionId: (s as any).sdkSessionId,
        status: s.status,
        prompt: (s as any).prompt,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
        eventCount: (s as any).events?.length || 0,
      }))
      .reverse(); // newest first

    res.json(sessions);
  }

  async getSession(req: AuthRequest, res: Response): Promise<void> {
    const project = await projectService.findById(req.params.id, req.userId!);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const session = (project.agentSessions || []).find(
      s => s.sessionId === req.params.sessionId
    );
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    res.json(session);
  }

  async cancelAgent(req: AuthRequest, res: Response): Promise<void> {
    const { sessionId } = req.body;
    if (!sessionId) { res.status(400).json({ error: 'sessionId is required' }); return; }
    claudeCodeService.cancelSession(sessionId);
    res.json({ message: 'Session cancelled' });
  }

  async getActiveSessions(_req: AuthRequest, res: Response): Promise<void> {
    const sessions = claudeCodeService.getActiveSessions();
    res.json(sessions);
  }

  async stopAllSessions(_req: AuthRequest, res: Response): Promise<void> {
    const count = claudeCodeService.stopAllSessions();
    // Also mark in DB
    const dbCleaned = await claudeCodeService.cleanupStaleSessions();
    res.json({ message: `Stopped ${count} active sessions, cleaned ${dbCleaned} DB records` });
  }
}
