import { Router } from 'express';
import { StrategicChatController } from '../controllers/strategic-chat.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new StrategicChatController();

router.use(authMiddleware);

router.post('/chat', (req: any, res: any) => controller.chat(req, res));
router.get('/messages', (req: any, res: any) => controller.getMessages(req, res));
router.put('/messages', (req: any, res: any) => controller.saveMessages(req, res));
router.delete('/messages', (req: any, res: any) => controller.clearMessages(req, res));
router.post('/execute-action', (req: any, res: any) => controller.executeAction(req, res));

export default router;
