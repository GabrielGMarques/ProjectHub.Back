import { Router } from 'express';
import { EmployeeController } from '../controllers/employee.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { managerService } from '../services/manager.service';

const router = Router();
const controller = new EmployeeController();

router.use(authMiddleware);

// Manager log
router.get('/manager/log', (_req: any, res: any) => {
  res.json({ running: managerService.isRunning(), log: managerService.getLog() });
});
router.post('/manager/check', async (_req: any, res: any) => {
  await managerService.runCheck();
  res.json({ message: 'Check completed', log: managerService.getLog().slice(-10) });
});
router.get('/manager/history', async (req: any, res: any) => {
  try {
    const history = await managerService.getHistory(req.userId);
    res.json(history);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
router.delete('/manager/history', async (req: any, res: any) => {
  try {
    await managerService.clearHistory(req.userId);
    res.json({ message: 'History cleared' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// System cleanup
router.post('/manager/cleanup', async (req: any, res: any) => {
  try {
    const result = await managerService.systemCleanup(req.userId);
    res.json({ message: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Static routes first
router.get('/roles', (req: any, res: any) => controller.getRoles(req, res));
router.get('/all', (req: any, res: any) => controller.getAll(req, res));
router.post('/hire', (req: any, res: any) => controller.hire(req, res));

// Project-scoped
router.get('/project/:projectId', (req: any, res: any) => controller.getByProject(req, res));
router.get('/project/:projectId/comms', (req: any, res: any) => controller.getComms(req, res));

// Role-level skills
router.get('/role-skills/:role', (req: any, res: any) => controller.getRoleSkills(req, res));

// Employee-specific
router.get('/:id', (req: any, res: any) => controller.getById(req, res));
router.delete('/:id', (req: any, res: any) => controller.fire(req, res));
router.post('/:id/task', (req: any, res: any) => controller.assignTask(req, res));
router.post('/:id/stop', (req: any, res: any) => controller.stopTask(req, res));
router.post('/:id/message', (req: any, res: any) => controller.sendMessage(req, res));
router.get('/:id/logs', (req: any, res: any) => controller.getLogs(req, res));
router.post('/:id/skills', (req: any, res: any) => controller.addSkill(req, res));
router.delete('/:id/skills/:skillName', (req: any, res: any) => controller.removeSkill(req, res));

export default router;
