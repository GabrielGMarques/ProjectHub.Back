import { Router } from 'express';
import { ClaudeCodeController } from '../controllers/claude-code.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new ClaudeCodeController();

router.use(authMiddleware);

router.get('/status', (req: any, res: any) => controller.getStatus(req, res));
router.post('/cancel', (req: any, res: any) => controller.cancelAgent(req, res));
router.get('/active-sessions', (req: any, res: any) => controller.getActiveSessions(req, res));
router.post('/stop-all', (req: any, res: any) => controller.stopAllSessions(req, res));

export default router;
