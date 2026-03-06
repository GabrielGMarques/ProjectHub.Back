import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ProjectService } from '../services/project.service';

const projectService = new ProjectService();

export class AnalyticsController {
  async getTimeAllocation(req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = await projectService.getTimeAllocation(req.userId!);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch time allocation data' });
    }
  }
}
