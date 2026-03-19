import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ProjectService } from '../services/project.service';
import { StrategicChatService } from '../services/strategic-chat.service';
import { ClaudeCodeService } from '../services/claude-code.service';
import { User } from '../models/user.model';
import { Project } from '../models/project.model';
import { AIModel } from '../services/ai.service';

const projectService = new ProjectService();
const strategicChatService = new StrategicChatService();
const claudeCodeService = new ClaudeCodeService();
import { TelemetryService } from '../services/telemetry.service';
const telemetryService = new TelemetryService();

export class StrategicChatController {

  async chat(req: AuthRequest, res: Response): Promise<void> {
    if (!strategicChatService.isConfigured) {
      res.status(503).json({ error: 'No AI provider configured' });
      return;
    }

    const { messages, model } = req.body as {
      messages: { role: 'user' | 'assistant'; content: string }[];
      model?: AIModel;
    };

    if (!messages?.length) {
      res.status(400).json({ error: 'messages are required' });
      return;
    }

    try {
      const projects = await projectService.findAllByUser(req.userId!);
      const response = await strategicChatService.chat(projects, messages, model || 'claude-sonnet');
      res.json({ response });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Strategic chat failed' });
    }
  }

  async saveMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { messages } = req.body;
      await User.findByIdAndUpdate(req.userId, { strategicChatMessages: messages || [] });
      res.json({ message: 'Messages saved' });
    } catch {
      res.status(500).json({ error: 'Failed to save messages' });
    }
  }

  async getMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      const user = await User.findById(req.userId);
      res.json(user?.strategicChatMessages || []);
    } catch {
      res.status(500).json({ error: 'Failed to load messages' });
    }
  }

  async clearMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      await User.findByIdAndUpdate(req.userId, { strategicChatMessages: [] });
      res.json({ message: 'Messages cleared' });
    } catch {
      res.status(500).json({ error: 'Failed to clear messages' });
    }
  }

  async executeAction(req: AuthRequest, res: Response): Promise<void> {
    const { action } = req.body;
    if (!action?.type) {
      res.status(400).json({ error: 'action is required' });
      return;
    }

    try {
      switch (action.type) {
        case 'add_todos': {
          if (!action.projectId || !action.items?.length) {
            res.status(400).json({ error: 'projectId and items required' });
            return;
          }
          const project = await projectService.findById(action.projectId, req.userId!);
          if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
          const newTodos = action.items.map((text: string) => ({ text, done: false, children: [] }));
          project.todos.push(...newTodos);
          await project.save();
          res.json({ message: `Added ${action.items.length} todos to ${project.name}`, project });
          break;
        }

        case 'update_field': {
          if (!action.projectId || !action.field) {
            res.status(400).json({ error: 'projectId and field required' });
            return;
          }
          const allowedFields = ['description', 'niche', 'monetizationPlan', 'impact', 'mrr', 'clientCount'];
          if (!allowedFields.includes(action.field)) {
            res.status(400).json({ error: `Field ${action.field} not allowed` });
            return;
          }
          const update: any = {};
          if (['mrr', 'clientCount'].includes(action.field)) {
            update[action.field] = Number(action.value) || 0;
          } else {
            update[action.field] = action.value;
          }
          const updated = await projectService.update(action.projectId, req.userId!, update);
          if (!updated) { res.status(404).json({ error: 'Project not found' }); return; }
          res.json({ message: `Updated ${action.field} on ${updated.name}`, project: updated });
          break;
        }

        case 'create_project': {
          if (!action.projectName) {
            res.status(400).json({ error: 'projectName required' });
            return;
          }
          const newProject = await projectService.create(req.userId!, {
            name: action.projectName,
            description: action.value || '',
          });
          res.json({ message: `Created project: ${newProject.name}`, project: newProject });
          break;
        }

        case 'run_agent': {
          if (!action.projectId || !action.prompt) {
            res.status(400).json({ error: 'projectId and prompt required' });
            return;
          }
          const project = await projectService.findById(action.projectId, req.userId!);
          if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
          const agentCwd = (project.folders || [])[0] || project.localPath;
          if (!agentCwd) {
            res.status(400).json({ error: 'Project has no folders configured' });
            return;
          }

          // Start agent as SSE stream
          req.setTimeout(0);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          let activeSessionId = '';

          req.on('close', () => {
            clientDisconnected = true;
            if (activeSessionId) claudeCodeService.cancelSession(activeSessionId);
          });

          try {
            const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
            const agentPrompt = this.buildAgentPrompt(project, action.prompt, apiBaseUrl);

            const result = await claudeCodeService.runCommand(
              agentCwd,
              agentPrompt,
              (event) => {
                if (event.sessionId) activeSessionId = event.sessionId;
                if (!clientDisconnected && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
              },
            );

            // Save session
            Project.findByIdAndUpdate(action.projectId, {
              $push: {
                agentSessions: {
                  sessionId: result.sessionId,
                  sdkSessionId: result.sdkSessionId,
                  type: 'claude-code',
                  status: result.status,
                  prompt: action.prompt,
                  events: result.events,
                  steps: [],
                  createdAt: result.events[0]?.timestamp || new Date(),
                  completedAt: new Date(),
                },
              },
            }).catch(() => {});
          } catch (error: any) {
            if (!clientDisconnected && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'error', content: error.message, sessionId: '', timestamp: new Date() })}\n\n`);
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        case 'prioritize': {
          if (!action.projectIds?.length) {
            res.status(400).json({ error: 'projectIds required' });
            return;
          }
          await projectService.reorder(req.userId!, action.projectIds, 'burndownSortOrder');
          res.json({ message: 'Projects reordered' });
          break;
        }

        default:
          res.status(400).json({ error: `Unknown action type: ${action.type}` });
      }
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Failed to execute action' });
      }
    }
  }

  private buildAgentPrompt(project: any, prompt: string, apiBaseUrl: string): string {
    const ctx: string[] = [];
    ctx.push(`Project: ${project.name}`);
    if (project.description) ctx.push(`Description: ${project.description}`);
    if (project.niche) ctx.push(`Niche: ${project.niche}`);
    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    if (allFolders.length) {
      ctx.push(`Working Directory (cwd): ${allFolders[0]}`);
      if (allFolders.length > 1) {
        ctx.push(`Project Folders (you have access to all of these):`);
        allFolders.forEach((p: string) => ctx.push(`  - ${p}`));
      }
    }

    ctx.push(`\n--- API ACCESS ---
You have access to the ProjectsHub backend API at: ${apiBaseUrl}
You can make API calls using curl with the Bash tool. Use these endpoints:

Project CRUD:
  GET    ${apiBaseUrl}/api/projects                    - List all projects
  GET    ${apiBaseUrl}/api/projects/${project._id}     - Get this project
  PATCH  ${apiBaseUrl}/api/projects/${project._id}     - Update this project (JSON body)
  POST   ${apiBaseUrl}/api/projects                    - Create new project (JSON body with "name")

Todos (update via PATCH):
  PATCH  ${apiBaseUrl}/api/projects/${project._id}     - Body: {"todos": [...]}

Note: API requires no auth header when called from localhost.
--- END API ACCESS ---`);

    return `[PROJECT CONTEXT]\n${ctx.join('\n')}\n[END PROJECT CONTEXT]\n\n${prompt}`;
  }
}
