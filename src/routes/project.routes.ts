import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller';
import { MarketingResearchController } from '../controllers/marketing-research.controller';
import { ClaudeCodeController } from '../controllers/claude-code.controller';
import { InfrastructureController } from '../controllers/infrastructure.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateProject } from '../middleware/validation.middleware';
import { body } from 'express-validator';
import { upload } from '../config/multer';

const router = Router();
const controller = new ProjectController();
const marketingController = new MarketingResearchController();
const claudeCodeController = new ClaudeCodeController();
const infraController = new InfrastructureController();

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
router.post('/pick-folder', (req: any, res: any) => controller.pickFolder(req, res));

// Parameterized routes
router.get('/:id', (req, res) => controller.getById(req, res));
router.put('/:id', validateProject, (req: any, res: any) => controller.update(req, res));
router.patch('/:id', validateProject, (req: any, res: any) => controller.update(req, res));
// Project deletion disabled — too destructive, employees can trigger it via Playwright
// router.delete('/:id', (req, res) => controller.delete(req, res));

// File explorer routes
router.get('/:id/files/list', (req: any, res: any) => controller.listFiles(req, res));
router.get('/:id/files/read', (req: any, res: any) => controller.readFile(req, res));
router.post('/:id/files/write', (req: any, res: any) => controller.writeFile(req, res));
router.post('/:id/files/open-in-explorer', (req: any, res: any) => controller.openInExplorer(req, res));

// Document routes
router.post('/:id/documents', upload.single('file'), (req: any, res: any) => controller.uploadDocument(req, res));
router.get('/:id/documents/:docId/download', (req: any, res: any) => controller.downloadDocument(req, res));
router.delete('/:id/documents/:docId', (req: any, res: any) => controller.deleteDocument(req, res));

// AI coaching
router.post('/:id/ai/coach', (req: any, res: any) => controller.aiCoach(req, res));
router.put('/:id/ai/coach/messages', (req: any, res: any) => controller.saveCoachMessages(req, res));
router.delete('/:id/ai/coach/messages', (req: any, res: any) => controller.clearCoachMessages(req, res));

// Marketing research
router.post('/:id/marketing/research', (req: any, res: any) => marketingController.runFullResearch(req, res));
router.post('/:id/marketing/research/:step', (req: any, res: any) => marketingController.runStep(req, res));
router.get('/:id/marketing/latest', (req: any, res: any) => marketingController.getLatest(req, res));

// Applications (per-company services/projects)
router.post('/:id/applications', (req: any, res: any) => infraController.addApplication(req, res));
router.put('/:id/applications/:name', (req: any, res: any) => infraController.updateApplication(req, res));
router.delete('/:id/applications/:name', (req: any, res: any) => infraController.removeApplication(req, res));

// Application screenshots
router.get('/:id/applications/:name/screenshots', (req: any, res: any) => infraController.listScreenshots(req, res));
router.post('/:id/applications/:name/screenshots', upload.single('file'), (req: any, res: any) => infraController.uploadScreenshot(req, res));
router.get('/:id/applications/:name/screenshots/:filename', (req: any, res: any) => infraController.getScreenshot(req, res));
router.delete('/:id/applications/:name/screenshots/:filename', (req: any, res: any) => infraController.deleteScreenshot(req, res));

// Claude Code agent
router.post('/:id/agent/run', (req: any, res: any) => claudeCodeController.runAgent(req, res));
router.post('/:id/agent/cancel', (req: any, res: any) => claudeCodeController.cancelAgent(req, res));
router.get('/:id/agent/sessions', (req: any, res: any) => claudeCodeController.getSessions(req, res));
router.get('/:id/agent/sessions/:sessionId', (req: any, res: any) => claudeCodeController.getSession(req, res));

export default router;
