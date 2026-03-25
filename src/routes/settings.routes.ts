import { Router } from 'express';
import { SettingsController } from '../controllers/settings.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new SettingsController();

router.use(authMiddleware);

// Model routing configuration
router.get('/model-routing', (req: any, res: any) => controller.getModelRouting(req, res));
router.patch('/model-routing/global', (req: any, res: any) => controller.updateGlobalDefault(req, res));
router.patch('/model-routing/action', (req: any, res: any) => controller.updateActionRoute(req, res));
router.patch('/model-routing/role', (req: any, res: any) => controller.updateRoleDefault(req, res));
router.patch('/model-routing/sub-agents', (req: any, res: any) => controller.updateSubAgentDefaults(req, res));
router.patch('/model-routing/escalation', (req: any, res: any) => controller.updateEscalation(req, res));
router.get('/model-routing/defaults', (req: any, res: any) => controller.getDefaults(req, res));
router.post('/model-routing/reset', (req: any, res: any) => controller.resetToDefaults(req, res));
router.get('/model-routing/cost-estimate', (req: any, res: any) => controller.getCostEstimate(req, res));

export default router;
