import { Response } from 'express';
import { validationResult } from 'express-validator';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
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

  async pickFolder(_req: AuthRequest, res: Response): Promise<void> {
    try {
      let cmd: string;
      switch (process.platform) {
        case 'win32':
          cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select a project folder'; $d.RootFolder = 'MyComputer'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { Write-Output '' }"`;
          break;
        case 'darwin':
          cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select a project folder")'`;
          break;
        default:
          cmd = `zenity --file-selection --directory --title="Select a project folder" 2>/dev/null || kdialog --getexistingdirectory ~ 2>/dev/null`;
          break;
      }

      exec(cmd, { timeout: 120000 }, (error, stdout) => {
        const selected = (stdout || '').trim();
        if (error || !selected) {
          res.json({ path: '' });
        } else {
          res.json({ path: selected });
        }
      });
    } catch {
      res.json({ path: '' });
    }
  }

  /** Get all valid folders for this project (folders[] + legacy localPath). */
  private getAllFolders(project: any): string[] {
    const folders = [...(project.folders || [])];
    // Backward compat: include legacy localPath if not already in folders
    if (project.localPath && !folders.includes(project.localPath)) {
      folders.unshift(project.localPath);
    }
    return folders.filter(Boolean);
  }

  /** Resolve the effective root path from `root` param or default to first folder. Validates against allowed paths. */
  private resolveRoot(project: any, rootParam?: string): string | null {
    const allFolders = this.getAllFolders(project);
    if (!allFolders.length) return null;
    if (!rootParam) return allFolders[0];
    const resolved = path.resolve(rootParam);
    if (allFolders.some((p: string) => path.resolve(p) === resolved)) return resolved;
    return null; // not allowed
  }

  async listFiles(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const rootPath = this.resolveRoot(project, req.query.root as string);
      if (!rootPath) { res.status(400).json({ error: 'No valid root path configured' }); return; }

      const relativePath = (req.query.path as string) || '';
      const targetPath = relativePath
        ? path.resolve(rootPath, relativePath)
        : rootPath;

      // Prevent path traversal outside root
      if (!targetPath.startsWith(path.resolve(rootPath))) {
        res.status(403).json({ error: 'Access denied: path outside project directory' });
        return;
      }

      let stat: fs.Stats;
      try { stat = fs.statSync(targetPath); } catch {
        res.status(400).json({ error: `Path not found: ${relativePath}` });
        return;
      }
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return;
      }

      const items = fs.readdirSync(targetPath, { withFileTypes: true });
      const entries: { name: string; path: string; isDir: boolean; size?: number; ext?: string }[] = [];

      const ignoredDirs = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', '.angular', '.vscode', 'coverage', '.idea']);

      for (const item of items) {
        if (item.name.startsWith('.') && item.name !== '.env.example' && item.name !== '.gitignore') continue;
        if (item.isDirectory() && ignoredDirs.has(item.name)) continue;

        try {
          const itemPath = path.join(targetPath, item.name);
          const rel = path.relative(rootPath, itemPath).replace(/\\/g, '/');
          if (item.isDirectory()) {
            entries.push({ name: item.name, path: rel, isDir: true });
          } else {
            const s = fs.statSync(itemPath);
            entries.push({ name: item.name, path: rel, isDir: false, size: s.size, ext: path.extname(item.name).toLowerCase() });
          }
        } catch { /* skip inaccessible */ }
      }

      // Sort: directories first, then alphabetically
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const rel = path.relative(rootPath, targetPath).replace(/\\/g, '/');
      res.json({
        current: rel || '',
        parent: rel ? path.dirname(rel).replace(/\\/g, '/') : null,
        entries,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to list files' });
    }
  }

  async readFile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const rootPath = this.resolveRoot(project, req.query.root as string);
      if (!rootPath) { res.status(400).json({ error: 'No valid root path configured' }); return; }

      const relativePath = req.query.path as string;
      if (!relativePath) { res.status(400).json({ error: 'path query parameter is required' }); return; }

      const targetPath = path.resolve(rootPath, relativePath);
      if (!targetPath.startsWith(path.resolve(rootPath))) {
        res.status(403).json({ error: 'Access denied: path outside project directory' });
        return;
      }

      let stat: fs.Stats;
      try { stat = fs.statSync(targetPath); } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      if (!stat.isFile()) { res.status(400).json({ error: 'Not a file' }); return; }

      // Limit file size to 2MB
      if (stat.size > 2 * 1024 * 1024) {
        res.status(400).json({ error: 'File too large (max 2MB)' });
        return;
      }

      const content = fs.readFileSync(targetPath, 'utf-8');
      res.json({ path: relativePath, content, size: stat.size });
    } catch (error) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }

  async writeFile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const rootPath = this.resolveRoot(project, req.body.root);
      if (!rootPath) { res.status(400).json({ error: 'No valid root path configured' }); return; }

      const { path: filePath, content } = req.body;
      if (!filePath || typeof content !== 'string') {
        res.status(400).json({ error: 'path and content are required' });
        return;
      }

      const targetPath = path.resolve(rootPath, filePath);
      if (!targetPath.startsWith(path.resolve(rootPath))) {
        res.status(403).json({ error: 'Access denied: path outside project directory' });
        return;
      }

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, 'utf-8');
      res.json({ message: 'File saved', path: filePath });
    } catch (error) {
      res.status(500).json({ error: 'Failed to write file' });
    }
  }

  async openInExplorer(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const rootPath = this.resolveRoot(project, req.body.root);
      if (!rootPath) { res.status(400).json({ error: 'No valid root path configured' }); return; }

      const relativePath = (req.body.path as string) || '';
      const targetPath = relativePath
        ? path.resolve(rootPath, relativePath)
        : rootPath;

      if (!targetPath.startsWith(path.resolve(rootPath))) {
        res.status(403).json({ error: 'Access denied: path outside project directory' });
        return;
      }

      // Determine the directory to open (if file, open its parent)
      let dirToOpen = targetPath;
      try {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) dirToOpen = path.dirname(targetPath);
      } catch {
        res.status(400).json({ error: 'Path not found' });
        return;
      }

      let cmd: string;
      switch (process.platform) {
        case 'win32': cmd = `explorer "${dirToOpen}"`; break;
        case 'darwin': cmd = `open "${dirToOpen}"`; break;
        default: cmd = `xdg-open "${dirToOpen}"`; break;
      }

      exec(cmd, (error) => {
        if (error) {
          res.status(500).json({ error: 'Failed to open file explorer' });
        } else {
          res.json({ message: 'Opened in file explorer' });
        }
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to open file explorer' });
    }
  }

  async getAvailableModels(_req: AuthRequest, res: Response): Promise<void> {
    res.json(await aiService.getAvailableModels());
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
      const response = await aiService.coach(project, messages, model as AIModel, req.userId);
      res.json({ response });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'AI coaching failed' });
    }
  }

  async saveCoachMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const { messages } = req.body;
      if (!Array.isArray(messages)) {
        res.status(400).json({ error: 'messages must be an array' });
        return;
      }
      project.coachMessages = messages;
      await project.save();
      res.json({ message: 'Coach messages saved' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save coach messages' });
    }
  }

  async clearCoachMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      const project = await projectService.findById(req.params.id, req.userId!);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      project.coachMessages = [];
      await project.save();
      res.json({ message: 'Coach messages cleared' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clear coach messages' });
    }
  }
}
