import { Router } from 'express';
import passport from 'passport';
import { AuthController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new AuthController();

router.get('/github', passport.authenticate('github', { scope: ['user', 'repo'] }));

router.get(
  '/github/callback',
  passport.authenticate('github', { session: false, failureRedirect: '/login' }),
  (req, res) => controller.githubCallback(req, res)
);

router.get('/profile', authMiddleware, (req, res) => controller.getProfile(req, res));

export default router;
