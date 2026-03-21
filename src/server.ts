import http from 'http';
import app from './app';
import { config } from './config';
import { connectDatabase } from './config/database';
import { ClaudeCodeService } from './services/claude-code.service';
import { telegramBot } from './services/telegram.service';
import { wsService } from './services/websocket.service';
import { User } from './models/user.model';
import { Project } from './models/project.model';
import { Employee } from './models/employee.model';
import { managerService } from './services/manager.service';

const claudeCodeService = new ClaudeCodeService();
const telegramService = telegramBot;

function countTodos(todos: any[]): number {
  let c = 0;
  for (const t of todos) { c++; if (t.children?.length) c += countTodos(t.children); }
  return c;
}
function countDone(todos: any[]): number {
  let c = 0;
  for (const t of todos) { if (t.done) c++; if (t.children?.length) c += countDone(t.children); }
  return c;
}

async function startServer(): Promise<void> {
  await connectDatabase();

  // Migration: mark all existing task results as read (one-time)
  await Employee.updateMany(
    { 'taskHistory.resultRead': { $exists: false } },
    { $set: { 'taskHistory.$[].resultRead': true } },
  ).then(r => { if (r.modifiedCount) console.log(`[Migration] Marked ${r.modifiedCount} employee(s) task results as read`); }).catch(() => {});

  // Recover from crash: mark any stale "running" sessions as cancelled
  const cleaned = await claudeCodeService.cleanupStaleSessions();
  if (cleaned > 0) {
    console.log(`[Startup] Cleaned up ${cleaned} stale agent sessions`);
  }

  // Start periodic cleanup of timed-out sessions
  claudeCodeService.startCleanupRoutine();

  // Telegram bot — always register command handler so setup screen can start polling later
  {
    const resolveUserId = async (): Promise<string> => {
      const user = await User.findOne().sort({ createdAt: 1 });
      return user?._id?.toString() || '';
    };

    // Daily digest function (used by scheduler AND /digest command)
    const sendDailyDigest = async () => {
      const userId = await resolveUserId();
      if (!userId) return;

      const projects = await Project.find({ userId });
      const allEmps = await Employee.find({ userId });

      if (!projects.length) return;

      let msg = `📋 *Daily Digest*\n\n`;

      for (const p of projects) {
        const todos = p.todos || [];
        const total = countTodos(todos);
        const done = countDone(todos);
        const pEmps = allEmps.filter(e => e.projectId.toString() === p._id.toString());
        const working = pEmps.filter(e => e.status === 'working').length;

        msg += `*${p.name}*`;
        if (total > 0) msg += ` — ${done}/${total} todos`;
        if (pEmps.length > 0) msg += ` | ${pEmps.length} employees`;
        if (working > 0) msg += ` (${working} working)`;
        msg += `\n`;

        const pending = todos.filter((t: any) => !t.done).slice(0, 5);
        if (pending.length) {
          for (const t of pending) {
            msg += `  ☐ ${(t as any).text}\n`;
          }
          const remaining = todos.filter((t: any) => !t.done).length - pending.length;
          if (remaining > 0) msg += `  _...and ${remaining} more_\n`;
        }
        msg += `\n`;
      }

      await telegramService.send(msg);
    };

    const telegramCommandHandler = async (cmd: string, args: string): Promise<string> => {
      const userId = await resolveUserId();
      if (!userId) return '⚠️ No user found. Log in to the web app first.';

      if (cmd === '/digest') {
        await sendDailyDigest();
        return '';
      }

      // Direct commands — no AI needed
      if (cmd === '/alfred-restart' || cmd === '/restart') {
        managerService.restart();
        return `🔄 Alfred restarted (loop: ${managerService.getLoopIntervalDisplay()}). Memory preserved.`;
      }

      if (cmd === '/alfred-interval' || cmd === '/interval') {
        const hours = parseFloat(args) || 0;
        if (!hours || hours < 0.01 || hours > 24) return '⚠️ Usage: /alfred-interval H.MM\n0.05 = 5min, 0.15 = 15min, 0.30 = 30min, 1 = 1h, 1.30 = 1h30min';
        managerService.setLoopInterval(hours);
        return `⏱️ Loop interval → ${managerService.getLoopIntervalDisplay()}`;
      }

      if (cmd === '/alfred-status') {
        return `🤖 *Alfred Status*\nRunning: ${managerService.isRunning() ? '✅' : '❌'}\nLoop: ${managerService.getLoopIntervalDisplay()}`;
      }

      if (cmd === '/delete-alfred-memory') {
        const result = await managerService.wipeMemory(userId);
        managerService.restart();
        return result + '\n\n🔄 Alfred restarted fresh.';
      }

      // Everything else goes to the AI Manager — natural language
      const message = args ? `${cmd} ${args}`.trim() : cmd;
      return managerService.handleMessage(message, userId);
    };

    // Always register the handler (so setup screen can start polling later)
    // Only actually start polling if bot token is already configured
    if (telegramService.isConfigured) {
      telegramService.startPolling(telegramCommandHandler);
      telegramService.send('🚀 *Alfred* is online!\nType /help for commands.').then(ok => {
        if (!ok) console.log('[Telegram] Send /start to the bot in Telegram to connect.');
      });
    } else {
      // Store handler so setup endpoint can start polling after token is set
      // Use a no-op startPolling that just saves the handler reference
      (telegramService as any).commandHandler = telegramCommandHandler;
      console.log('[Telegram] No bot token configured. Use HR > Manager tab to set up.');
    }

    // Schedule daily at 9:00 AM
    const scheduleDaily = () => {
      const now = new Date();
      const next9am = new Date();
      next9am.setHours(9, 0, 0, 0);
      if (now >= next9am) next9am.setDate(next9am.getDate() + 1);
      const msUntil = next9am.getTime() - now.getTime();

      setTimeout(() => {
        sendDailyDigest().catch(() => {});
        // Then repeat every 24h
        setInterval(() => sendDailyDigest().catch(() => {}), 24 * 60 * 60 * 1000);
      }, msUntil);

      console.log(`[Telegram] Daily digest scheduled for ${next9am.toLocaleTimeString()}`);
    };

    scheduleDaily();
  }

  // Start the always-on Manager
  managerService.start();

  const server = http.createServer(app);
  wsService.init(server);
  server.listen(config.port, () => {
    console.log(`Server running on port ${config.port} (WebSocket on /ws)`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[Shutdown] Stopping services...');
    const stopped = claudeCodeService.stopAllSessions();
    if (stopped > 0) console.log(`[Shutdown] Stopped ${stopped} sessions`);
    claudeCodeService.stopCleanupRoutine();
    managerService.stop();
    telegramService.stopPolling();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Crash recovery — log and exit (nodemon will restart)
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err.message);
    console.error(err.stack);
    telegramService.send(`🚨 *Server crashed:* ${err.message.substring(0, 200)}\n_Restarting..._`).catch(() => {});
    // Give Telegram message time to send, then exit so nodemon restarts
    setTimeout(() => process.exit(1), 2000);
  });

  process.on('unhandledRejection', (reason: any) => {
    console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
    if (reason?.stack) console.error(reason.stack);
    telegramService.send(`🚨 *Unhandled rejection:* ${(reason?.message || String(reason)).substring(0, 200)}\n_Restarting..._`).catch(() => {});
    setTimeout(() => process.exit(1), 2000);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
