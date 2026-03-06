import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateProject } from '../middleware/validation.middleware';
import { body } from 'express-validator';

const router = Router();
const controller = new ProjectController();

router.use(authMiddleware);

router.get('/', (req, res) => controller.getAll(req, res));
router.get('/:id', (req, res) => controller.getById(req, res));
router.post(
  '/',
  [body('name').notEmpty().isString().trim().withMessage('Name is required'), ...validateProject],
  (req: any, res: any) => controller.create(req, res)
);
router.put('/:id', validateProject, (req: any, res: any) => controller.update(req, res));
router.patch('/:id', validateProject, (req: any, res: any) => controller.update(req, res));
router.delete('/:id', (req, res) => controller.delete(req, res));

export default router;
