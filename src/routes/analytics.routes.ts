import { Router } from 'express';
import { AnalyticsController } from '../controllers/analytics.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new AnalyticsController();

router.use(authMiddleware);

router.get('/time-allocation', (req, res) => controller.getTimeAllocation(req, res));

export default router;
