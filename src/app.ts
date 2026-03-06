import express from 'express';
import cors from 'cors';
import passport from 'passport';
import { config } from './config';
import { configurePassport } from './config/passport';
import projectRoutes from './routes/project.routes';
import authRoutes from './routes/auth.routes';
import githubRoutes from './routes/github.routes';
import analyticsRoutes from './routes/analytics.routes';

const app = express();

// Middleware
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());
app.use(passport.initialize());

// Configure Passport
configurePassport();

// Routes
app.use('/api/projects', projectRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/analytics', analyticsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default app;
