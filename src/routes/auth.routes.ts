import { Router } from 'express';
import passport from 'passport';
import { AuthController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const controller = new AuthController();

function requireGitHubConfig(req: any, res: any, next: any): void {
  if (!config.github.clientId || !config.github.clientSecret) {
    res.status(501).json({
      error: 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in your .env file.',
    });
    return;
  }
  next();
}

router.get('/github', requireGitHubConfig, passport.authenticate('github', { scope: ['user', 'repo'] }));

router.get(
  '/github/callback',
  requireGitHubConfig,
  passport.authenticate('github', { session: false, failureRedirect: '/login' }),
  (req, res) => controller.githubCallback(req, res)
);

router.get('/profile', authMiddleware, (req, res) => controller.getProfile(req, res));

export default router;
