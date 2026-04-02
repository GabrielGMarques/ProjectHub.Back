import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { obsidianSyncService } from '../services/obsidian-sync.service';

export class ObsidianSyncController {

  async trigger(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { full, publishToDrive } = req.body || {};
      const result = await obsidianSyncService.sync(req.userId!, { full, publishToDrive });
      res.json({ message: 'Sync complete', ...result });
    } catch (err: any) {
      const status = err.message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  }

  async getStatus(_req: AuthRequest, res: Response): Promise<void> {
    try {
      res.json(obsidianSyncService.getStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
