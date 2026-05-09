import { Router } from 'express';
import { FirewallController } from '../controllers/firewall.controller';

const router = Router();
const controller = new FirewallController();

// All routes are PUBLIC — this IS the auth layer for the gateway.
router.post('/request', (req: any, res: any) => controller.request(req, res));
router.get('/status', (req: any, res: any) => controller.status(req, res));
router.get('/validate', (req: any, res: any) => controller.validate(req, res));
router.post('/set-cookie', (req: any, res: any) => controller.setCookie(req, res));
router.post('/share', (req: any, res: any) => controller.share(req, res));
router.get('/access', (req: any, res: any) => controller.access(req, res));

export default router;
