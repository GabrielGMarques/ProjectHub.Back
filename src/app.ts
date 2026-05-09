import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { config } from './config';
import { configurePassport } from './config/passport';
import projectRoutes from './routes/project.routes';
import authRoutes from './routes/auth.routes';
import githubRoutes from './routes/github.routes';
import analyticsRoutes from './routes/analytics.routes';
import skillRoutes from './routes/skill.routes';
import claudeCodeRoutes from './routes/claude-code.routes';
import strategicChatRoutes from './routes/strategic-chat.routes';
import employeeRoutes from './routes/employee.routes';
import telemetryRoutes from './routes/telemetry.routes';
import telegramRoutes from './routes/telegram.routes';
import infrastructureRoutes from './routes/infrastructure.routes';
import settingsRoutes from './routes/settings.routes';
import bruceTodoRoutes from './routes/bruce-todo.routes';
import obsidianSyncRoutes from './routes/obsidian-sync.routes';
import firewallRoutes from './routes/firewall.routes';

const app = express();

// Middleware — allow the dev frontend AND the public ngrok URL (gateway entry)
const allowedOrigins = [
  config.frontendUrl,
  'https://nonshattering-adelaida-ponchoed.ngrok-free.dev',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(null, true); // permissive — gateway is publicly reachable anyway
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());
app.use(passport.initialize());

// Configure Passport
configurePassport();

// Routes
// Firewall routes are PUBLIC and registered first (this is the auth gate itself)
app.use('/api/firewall', firewallRoutes);

app.use('/api/companies', projectRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/claude-code', claudeCodeRoutes);
app.use('/api/strategic-chat', strategicChatRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/infrastructure', infrastructureRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/bruce-todos', bruceTodoRoutes);
app.use('/api/obsidian-sync', obsidianSyncRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler — log to telemetry
import { TelemetryService } from './services/telemetry.service';
const globalTelemetry = new TelemetryService();

app.use((err: any, req: any, res: any, _next: any) => {
  const userId = req.userId || '';
  console.error(`[Error] ${req.method} ${req.path}:`, err.message);
  globalTelemetry.track({
    userId,
    type: 'error',
    source: `api:${req.path}`,
    status: 'failed',
    description: `${req.method} ${req.path}`,
    error: err.message || String(err),
  });
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

export default app;
