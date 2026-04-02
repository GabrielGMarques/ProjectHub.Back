import { Router } from 'express';
import { InfrastructureController } from '../controllers/infrastructure.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new InfrastructureController();

router.use(authMiddleware);

// Gateway management
router.get('/status', (req: any, res: any) => controller.getStatus(req, res));
router.post('/gateway/start', (req: any, res: any) => controller.startGateway(req, res));
router.post('/gateway/stop', (req: any, res: any) => controller.stopGateway(req, res));
router.post('/gateway/restart', (req: any, res: any) => controller.restartGateway(req, res));
router.post('/gateway/reload', (req: any, res: any) => controller.reloadGateway(req, res));
router.post('/gateway/regenerate', (req: any, res: any) => controller.regenerateNginx(req, res));

// Ngrok
router.post('/ngrok/start', (req: any, res: any) => controller.startNgrok(req, res));
router.post('/ngrok/stop', (req: any, res: any) => controller.stopNgrok(req, res));

// All applications across companies
router.get('/applications', (req: any, res: any) => controller.getAllApplications(req, res));

export default router;
