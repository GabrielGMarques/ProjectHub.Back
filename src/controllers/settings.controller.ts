import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { modelRoutingService } from '../services/model-routing.service';
import { FACTORY_DEFAULTS, ModelTier } from '../models/model-routing.model';

export class SettingsController {

  async getModelRouting(req: AuthRequest, res: Response): Promise<void> {
    try {
      const config = await modelRoutingService.getConfig(req.userId!);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async updateGlobalDefault(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { model } = req.body;
      if (!['haiku', 'sonnet', 'opus'].includes(model)) {
        res.status(400).json({ error: 'model must be haiku, sonnet, or opus' }); return;
      }
      const config = await modelRoutingService.updateGlobalDefault(req.userId!, model as ModelTier);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async updateActionRoute(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { action, model } = req.body;
      if (!action || !['haiku', 'sonnet', 'opus'].includes(model)) {
        res.status(400).json({ error: 'action and model (haiku/sonnet/opus) required' }); return;
      }
      const config = await modelRoutingService.updateActionRoute(req.userId!, action, model as ModelTier);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async updateRoleDefault(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { role, model } = req.body;
      if (!role || !['haiku', 'sonnet', 'opus'].includes(model)) {
        res.status(400).json({ error: 'role and model (haiku/sonnet/opus) required' }); return;
      }
      const config = await modelRoutingService.updateRoleDefault(req.userId!, role, model as ModelTier);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async updateSubAgentDefaults(req: AuthRequest, res: Response): Promise<void> {
    try {
      const config = await modelRoutingService.updateSubAgentDefaults(req.userId!, req.body);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async updateEscalation(req: AuthRequest, res: Response): Promise<void> {
    try {
      const config = await modelRoutingService.updateEscalation(req.userId!, req.body);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async getDefaults(_req: AuthRequest, res: Response): Promise<void> {
    res.json(FACTORY_DEFAULTS);
  }

  async resetToDefaults(req: AuthRequest, res: Response): Promise<void> {
    try {
      const config = await modelRoutingService.resetToDefaults(req.userId!);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async getCostEstimate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const estimate = await modelRoutingService.getCostEstimate(req.userId!, days);
      res.json(estimate);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
