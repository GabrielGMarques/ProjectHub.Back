import { Router } from 'express';
import { SkillController } from '../controllers/skill.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new SkillController();

router.use(authMiddleware);

router.get('/', (req: any, res: any) => controller.getAll(req, res));
router.post('/', (req: any, res: any) => controller.create(req, res));
router.put('/:id', (req: any, res: any) => controller.update(req, res));
router.delete('/:id', (req: any, res: any) => controller.delete(req, res));
router.post('/:id/execute/:projectId', (req: any, res: any) => controller.execute(req, res));

export default router;
