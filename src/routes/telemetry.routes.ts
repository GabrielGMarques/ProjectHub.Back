import { Router } from 'express';
import { TelemetryController } from '../controllers/telemetry.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new TelemetryController();

router.use(authMiddleware);

router.get('/events', (req: any, res: any) => controller.getEvents(req, res));
router.get('/stats', (req: any, res: any) => controller.getStats(req, res));
router.get('/errors', (req: any, res: any) => controller.getErrors(req, res));
router.get('/execution-log', (req: any, res: any) => controller.getExecutionLog(req, res));
router.get('/manager-logs', (req: any, res: any) => controller.getManagerLogs(req, res));
router.get('/employee-logs', (req: any, res: any) => controller.getEmployeeLogs(req, res));

export default router;
