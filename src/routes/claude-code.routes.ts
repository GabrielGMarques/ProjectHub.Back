import { Router } from 'express';
import { ClaudeCodeController } from '../controllers/claude-code.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new ClaudeCodeController();

router.use(authMiddleware);

router.get('/status', (req: any, res: any) => controller.getStatus(req, res));
router.post('/cancel', (req: any, res: any) => controller.cancelAgent(req, res));

export default router;
