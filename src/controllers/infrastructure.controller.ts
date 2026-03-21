import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { AuthRequest } from '../middleware/auth.middleware';
import { infrastructureService } from '../services/infrastructure.service';
import { Project } from '../models/project.model';

const SCREENSHOTS_DIR = path.resolve(__dirname, '../../../ManagerMemory/screenshots');

export class InfrastructureController {

  /** GET /api/infrastructure/status */
  async getStatus(_req: AuthRequest, res: Response): Promise<void> {
    res.json({
      gatewayPort: infrastructureService.getGatewayPort(),
      ngrokUrl: infrastructureService.getNgrokUrl(),
      ngrokRunning: infrastructureService.isNgrokRunning(),
    });
  }

  /** POST /api/infrastructure/gateway/start */
  async startGateway(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await infrastructureService.startGateway();
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/infrastructure/gateway/stop */
  async stopGateway(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await infrastructureService.stopGateway();
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/infrastructure/gateway/restart */
  async restartGateway(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await infrastructureService.restartGateway(req.userId!);
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/infrastructure/gateway/reload */
  async reloadGateway(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await infrastructureService.reloadGateway();
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/infrastructure/gateway/regenerate */
  async regenerateNginx(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await infrastructureService.regenerateNginx(req.userId!);
      res.json({ message: `Nginx config regenerated: ${result.locations} locations across ${result.companies} companies` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/infrastructure/ngrok/start */
  async startNgrok(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await infrastructureService.startNgrok();
      res.json({ message: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/infrastructure/ngrok/stop */
  async stopNgrok(_req: AuthRequest, res: Response): Promise<void> {
    const result = infrastructureService.stopNgrok();
    res.json({ message: result });
  }

  /** GET /api/infrastructure/applications */
  async getAllApplications(req: AuthRequest, res: Response): Promise<void> {
    const apps = await infrastructureService.getAllApplications(req.userId!);
    res.json(apps);
  }

  /** POST /api/projects/:id/applications */
  async addApplication(req: AuthRequest, res: Response): Promise<void> {
    try {
      const app = await infrastructureService.addApplication(req.userId!, req.params.id, req.body);
      res.status(201).json(app);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** PUT /api/projects/:id/applications/:name */
  async updateApplication(req: AuthRequest, res: Response): Promise<void> {
    try {
      const app = await infrastructureService.updateApplication(
        req.userId!, req.params.id, req.params.name, req.body
      );
      res.json(app);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** DELETE /api/projects/:id/applications/:name */
  async removeApplication(req: AuthRequest, res: Response): Promise<void> {
    try {
      await infrastructureService.removeApplication(req.userId!, req.params.id, req.params.name);
      res.json({ message: 'Application removed' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** POST /api/projects/:id/applications/:name/screenshots — upload a screenshot */
  async uploadScreenshot(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, name } = req.params;
      const file = (req as any).file;
      if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }

      const project = await Project.findOne({ _id: id, userId: req.userId });
      if (!project) { res.status(404).json({ error: 'Company not found' }); return; }

      const app = project.applications.find(a => a.name === name);
      if (!app) { res.status(404).json({ error: `Application "${name}" not found` }); return; }

      // Move file to screenshots dir
      const screenshotsDir = path.join(SCREENSHOTS_DIR, id, name);
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

      const destFile = path.join(screenshotsDir, file.filename);
      fs.renameSync(file.path, destFile);

      app.screenshots.push({
        filename: file.filename,
        originalName: file.originalname,
        caption: (req.body.caption as string) || '',
        takenBy: (req.body.takenBy as string) || 'manual',
        takenAt: new Date(),
      });
      await project.save();

      res.status(201).json(app.screenshots[app.screenshots.length - 1]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/projects/:id/applications/:name/screenshots/:filename */
  async getScreenshot(req: AuthRequest, res: Response): Promise<void> {
    const { id, name, filename } = req.params;
    const safeName = filename.replace(/[/\\..]/g, '');
    const filePath = path.join(SCREENSHOTS_DIR, id, name, safeName);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Screenshot not found' });
      return;
    }
    res.sendFile(filePath);
  }

  /** DELETE /api/projects/:id/applications/:name/screenshots/:filename */
  async deleteScreenshot(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, name, filename } = req.params;
      const project = await Project.findOne({ _id: id, userId: req.userId });
      if (!project) { res.status(404).json({ error: 'Company not found' }); return; }

      const app = project.applications.find(a => a.name === name);
      if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

      app.screenshots = app.screenshots.filter(s => s.filename !== filename);
      await project.save();

      // Delete file
      const safeName = filename.replace(/[/\\..]/g, '');
      const filePath = path.join(SCREENSHOTS_DIR, id, name, safeName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      res.json({ message: 'Screenshot deleted' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
