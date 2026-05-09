import { Router } from 'express';
import { EmployeeController } from '../controllers/employee.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { managerService } from '../services/manager.service';

const router = Router();
const controller = new EmployeeController();

// Self-management — NO auth required (called by employee agents via curl)
// Validated by employee ObjectId — agents don't have JWT tokens
router.post('/:id/self/status', (req: any, res: any) => controller.selfSetStatus(req, res));
router.post('/:id/self/task-done', (req: any, res: any) => controller.selfTaskDone(req, res));
router.post('/:id/self/dismiss', (req: any, res: any) => controller.selfDismiss(req, res));
router.post('/:id/self/task-update', (req: any, res: any) => controller.selfTaskUpdate(req, res));
router.post('/:id/self/working-status', (req: any, res: any) => controller.selfWorkingStatus(req, res));
router.get('/:id/self/status-history', (req: any, res: any) => controller.getSelfStatusHistory(req, res));
router.get('/:id/self/team', (req: any, res: any) => controller.getSelfTeam(req, res));
router.get('/:id/self/teammate/:teammateId', (req: any, res: any) => controller.getSelfTeammateStatus(req, res));
router.get('/:id/self/direction', (req: any, res: any) => controller.getSelfDirection(req, res));
router.post('/:id/self/direction', (req: any, res: any) => controller.setSelfDirection(req, res));
router.get('/:id/self/applications', (req: any, res: any) => controller.getSelfApplications(req, res));
router.post('/:id/self/applications', (req: any, res: any) => controller.selfUpsertApplication(req, res));
router.post('/:id/self/applications/:appName/screenshots', (req: any, res: any) => controller.selfUploadScreenshot(req, res));
router.post('/:id/self/inbox', (req: any, res: any) => controller.selfSendInbox(req, res));
router.post('/:id/self/escalate', (req: any, res: any) => controller.selfEscalate(req, res));

// Catch-all for unknown /self/* routes — return 404 instead of falling through to auth
router.all('/:id/self/*', (req: any, res: any) => {
  res.status(404).json({
    error: 'Unknown self-service endpoint',
    availableEndpoints: [
      'POST /self/status', 'POST /self/task-done', 'POST /self/dismiss', 'POST /self/task-update',
      'POST /self/working-status', 'GET /self/status-history', 'GET /self/team',
      'GET /self/teammate/:id', 'GET /self/direction', 'POST /self/direction',
      'GET /self/applications', 'POST /self/applications',
      'POST /self/applications/:appName/screenshots', 'POST /self/inbox',
      'POST /self/escalate',
    ],
  });
});

// Everything below requires auth
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

// Skills
router.get('/local-skills', (req: any, res: any) => controller.getLocalSkills(req, res));
router.get('/role-skills/:role', (req: any, res: any) => controller.getRoleSkills(req, res));
router.put('/role-skills/:role', (req: any, res: any) => controller.setRoleSkills(req, res));

// Employee-specific
router.get('/:id', (req: any, res: any) => controller.getById(req, res));
router.patch('/:id/prompt', (req: any, res: any) => controller.updatePrompt(req, res));
router.delete('/:id', (req: any, res: any) => controller.fire(req, res));
router.post('/:id/task', (req: any, res: any) => controller.assignTask(req, res));
router.post('/:id/stop', (req: any, res: any) => controller.stopTask(req, res));
router.post('/:id/message', (req: any, res: any) => controller.sendMessage(req, res));

// Heartbeat — periodic recurring task config
router.get('/:id/heartbeat', (req: any, res: any) => controller.getHeartbeat(req, res));
router.put('/:id/heartbeat', (req: any, res: any) => controller.updateHeartbeat(req, res));
router.get('/:id/logs', (req: any, res: any) => controller.getLogs(req, res));
router.get('/:id/status-history', (req: any, res: any) => controller.getStatusHistory(req, res));

// Session history (per-employee + global)
router.get('/:id/sessions', (req: any, res: any) => controller.getEmployeeSessions(req, res));
router.get('/sessions/all', (req: any, res: any) => controller.getAllSessions(req, res));
router.get('/sessions/:sessionId', (req: any, res: any) => controller.getSessionDetail(req, res));
router.post('/:id/skills', (req: any, res: any) => controller.addSkill(req, res));
router.delete('/:id/skills/:skillName', (req: any, res: any) => controller.removeSkill(req, res));

// Memory
router.get('/:id/memories', (req: any, res: any) => controller.getMemories(req, res));
router.post('/:id/memories', (req: any, res: any) => controller.addMemory(req, res));
router.delete('/:id/memories/:memoryId', (req: any, res: any) => controller.deleteMemory(req, res));
router.delete('/:id/memories', (req: any, res: any) => controller.wipeMemories(req, res));
router.post('/:id/compact', (req: any, res: any) => controller.compactLogs(req, res));

// Debug
router.get('/:id/debug-config', (req: any, res: any) => controller.getDebugConfig(req, res));

// Control
router.post('/:id/restart', (req: any, res: any) => controller.restartEmployee(req, res));
router.post('/:id/clear-session', (req: any, res: any) => controller.clearSession(req, res));

export default router;
