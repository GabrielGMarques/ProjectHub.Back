import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller';
import { MarketingResearchController } from '../controllers/marketing-research.controller';
import { ClaudeCodeController } from '../controllers/claude-code.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateProject } from '../middleware/validation.middleware';
import { body } from 'express-validator';
import { upload } from '../config/multer';

const router = Router();
const controller = new ProjectController();
const marketingController = new MarketingResearchController();
const claudeCodeController = new ClaudeCodeController();

router.use(authMiddleware);

router.get('/', (req, res) => controller.getAll(req, res));
router.post(
  '/',
  [body('name').notEmpty().isString().trim().withMessage('Name is required'), ...validateProject],
  (req: any, res: any) => controller.create(req, res)
);

// Static routes BEFORE parameterized routes
router.put('/reorder', (req: any, res: any) => controller.reorder(req, res));
router.get('/ai/models', (req: any, res: any) => controller.getAvailableModels(req, res));
router.get('/browse-folders', (req: any, res: any) => controller.browseFolders(req, res));

// Parameterized routes
router.get('/:id', (req, res) => controller.getById(req, res));
router.put('/:id', validateProject, (req: any, res: any) => controller.update(req, res));
router.patch('/:id', validateProject, (req: any, res: any) => controller.update(req, res));
router.delete('/:id', (req, res) => controller.delete(req, res));

// Document routes
router.post('/:id/documents', upload.single('file'), (req: any, res: any) => controller.uploadDocument(req, res));
router.get('/:id/documents/:docId/download', (req: any, res: any) => controller.downloadDocument(req, res));
router.delete('/:id/documents/:docId', (req: any, res: any) => controller.deleteDocument(req, res));

// AI coaching
router.post('/:id/ai/coach', (req: any, res: any) => controller.aiCoach(req, res));

// Marketing research
router.post('/:id/marketing/research', (req: any, res: any) => marketingController.runFullResearch(req, res));
router.post('/:id/marketing/research/:step', (req: any, res: any) => marketingController.runStep(req, res));
router.get('/:id/marketing/latest', (req: any, res: any) => marketingController.getLatest(req, res));

// Claude Code agent
router.post('/:id/agent/run', (req: any, res: any) => claudeCodeController.runAgent(req, res));
router.post('/:id/agent/cancel', (req: any, res: any) => claudeCodeController.cancelAgent(req, res));

export default router;
