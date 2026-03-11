import { Response } from 'express';
import { validationResult } from 'express-validator';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { AuthRequest } from '../middleware/auth.middleware';
import { ProjectService } from '../services/project.service';
import { AIService, AIModel } from '../services/ai.service';

const projectService = new ProjectService();
const aiService = new AIService();

export class ProjectController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const projects = await projectService.findAllByUser(req.userId!);
      res.json(projects);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch projects' });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch project' });
    }
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const project = await projectService.create(req.userId!, req.body);
      res.status(201).json(project);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create project' });
    }
  }

  async update(req: AuthRequest, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const project = await projectService.update(req.params.id, req.userId!, req.body);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      res.status(500).json({ error: 'Failed to update project' });
    }
  }

  async reorder(req: AuthRequest, res: Response): Promise<void> {
    const { projectIds, field } = req.body;
    if (!Array.isArray(projectIds)) {
      res.status(400).json({ error: 'projectIds must be an array' });
      return;
    }
    const sortField = field === 'burndownSortOrder' ? 'burndownSortOrder' : 'sortOrder';
    try {
      await projectService.reorder(req.userId!, projectIds, sortField);
      res.json({ message: 'Projects reordered successfully' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reorder projects' });
    }
  }

  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.delete(req.params.id, req.userId!);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ message: 'Project deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete project' });
    }
  }

  async uploadDocument(req: AuthRequest, res: Response): Promise<void> {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const doc = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date(),
      };
      const project = await projectService.addDocument(req.params.id, req.userId!, doc);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      res.status(500).json({ error: 'Failed to upload document' });
    }
  }

  async deleteDocument(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.removeDocument(req.params.id, req.userId!, req.params.docId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete document' });
    }
  }

  async downloadDocument(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const doc = (project.documents as any)?.id(req.params.docId);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const filePath = path.join(__dirname, '../../uploads', doc.filename);
      res.download(filePath, doc.originalName);
    } catch (error) {
      res.status(500).json({ error: 'Failed to download document' });
    }
  }

  async browseFolders(req: AuthRequest, res: Response): Promise<void> {
    try {
      const requestedPath = (req.query.path as string) || '';

      let targetPath: string;
      if (!requestedPath) {
        // Return drive roots on Windows, home dir on Unix
        if (process.platform === 'win32') {
          // List available drive letters
          const drives: { name: string; path: string; isDir: true }[] = [];
          for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
            const drivePath = `${letter}:\\`;
            try {
              fs.accessSync(drivePath);
              drives.push({ name: `${letter}:`, path: drivePath, isDir: true });
            } catch { /* drive not available */ }
          }
          res.json({ current: '', entries: drives });
          return;
        } else {
          targetPath = os.homedir();
        }
      } else {
        targetPath = path.resolve(requestedPath);
      }

      // Verify it exists and is a directory
      let stat: fs.Stats;
      try {
        stat = fs.statSync(targetPath);
      } catch {
        res.status(400).json({ error: `Path not found: ${targetPath}` });
        return;
      }
      if (!stat.isDirectory()) {
        res.status(400).json({ error: `Not a directory: ${targetPath}` });
        return;
      }

      const entries: { name: string; path: string; isDir: boolean }[] = [];
      const items = fs.readdirSync(targetPath, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === '$Recycle.Bin' || item.name === 'System Volume Information') continue;
        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            path: path.join(targetPath, item.name),
            isDir: true,
          });
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        current: targetPath,
        parent: path.dirname(targetPath) !== targetPath ? path.dirname(targetPath) : null,
        entries,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to browse folders' });
    }
  }

  async getAvailableModels(_req: AuthRequest, res: Response): Promise<void> {
    res.json(aiService.getAvailableModels());
  }

  async aiCoach(req: AuthRequest, res: Response): Promise<void> {
    if (!aiService.isConfigured) {
      res.status(503).json({ error: 'AI coaching is not configured. Set at least one API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY).' });
      return;
    }
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const { messages, model } = req.body;
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages array is required' });
        return;
      }
      const response = await aiService.coach(project, messages, model as AIModel);
      res.json({ response });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'AI coaching failed' });
    }
  }
}
