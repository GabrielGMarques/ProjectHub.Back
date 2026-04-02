import { Router } from 'express';
import { TelegramController } from '../controllers/telegram.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new TelegramController();

router.use(authMiddleware);

router.get('/status', (req: any, res: any) => controller.getStatus(req, res));
router.get('/discover', (req: any, res: any) => controller.discover(req, res));
router.post('/setup', (req: any, res: any) => controller.setup(req, res));
router.post('/test-send', (req: any, res: any) => controller.testSend(req, res));

export default router;
