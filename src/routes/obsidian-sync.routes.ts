import { Router } from 'express';
import { ObsidianSyncController } from '../controllers/obsidian-sync.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new ObsidianSyncController();

router.use(authMiddleware);

router.post('/trigger', (req: any, res: any) => controller.trigger(req, res));
router.get('/status', (req: any, res: any) => controller.getStatus(req, res));

export default router;
