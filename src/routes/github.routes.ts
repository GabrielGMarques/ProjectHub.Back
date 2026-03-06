import { Router } from 'express';
import { GitHubController } from '../controllers/github.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new GitHubController();

router.use(authMiddleware);

router.get('/repos', (req, res) => controller.getRepos(req, res));
router.get('/repos/:owner/:repo', (req, res) => controller.getRepoDetails(req, res));

export default router;
