import { Router } from 'express';
import { BruceTodoController } from '../controllers/bruce-todo.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new BruceTodoController();

router.use(authMiddleware);

router.get('/', (req, res) => controller.list(req, res));
router.post('/', (req, res) => controller.add(req, res));
router.post('/batch', (req, res) => controller.addMany(req, res));
router.patch('/:id/toggle', (req, res) => controller.toggle(req, res));
router.patch('/:id', (req, res) => controller.update(req, res));
router.delete('/done', (req, res) => controller.clearDone(req, res));
router.delete('/:id', (req, res) => controller.remove(req, res));

export default router;
