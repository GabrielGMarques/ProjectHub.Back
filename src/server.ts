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
import { EmployeeSession } from './models/employee-session.model';
import { managerService } from './services/manager.service';
import { heartbeatService } from './services/heartbeat.service';
import { infrastructureService } from './services/infrastructure.service';
import { firewallTelegramService } from './services/firewall-telegram.service';
import { firewallService } from './services/firewall.service';

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

  // Ensure the gateway nginx project files always exist (so docker-compose can mount them)
  try {
    infrastructureService.ensureNginxProject();
  } catch (err: any) {
    console.warn(`[Startup] ensureNginxProject failed: ${err.message}`);
  }

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

  // ── Clear all employee SDK session state ──────────────────────────────
  // Restarting the backend kills every in-memory SDK conversation. Any
  // employee with a non-empty activeSessionId or status='working' is now
  // pointing at a ghost. Reset them to idle so the next task starts clean,
  // and close any open EmployeeSession rows in the history with reason='restarted'.
  try {
    const empResult = await Employee.updateMany(
      {
        $or: [
          { activeSessionId: { $nin: ['', null] } },
          { sdkSessionId: { $nin: ['', null] } },
          { currentTask: { $nin: ['', null] } },
          { status: 'working' },
        ],
      },
      {
        $set: {
          activeSessionId: '',
          sdkSessionId: '',
          currentTask: '',
          status: 'idle',
          lastActivity: new Date(),
        },
      },
    );
    if (empResult.modifiedCount > 0) {
      console.log(`[Startup] Reset ${empResult.modifiedCount} employee(s) to idle — stale SDK sessions cleared`);
    }

    // Close open session rows. MongoDB aggregation-pipeline update lets us
    // compute durationMs per row from startedAt in a single query.
    const sessionResult = await EmployeeSession.updateMany(
      { endedAt: { $exists: false } },
      [
        {
          $set: {
            endedAt: '$$NOW',
            endReason: 'restarted',
            durationMs: { $subtract: ['$$NOW', '$startedAt'] },
          },
        },
      ],
    );
    if (sessionResult.modifiedCount > 0) {
      console.log(`[Startup] Closed ${sessionResult.modifiedCount} open session row(s) as 'restarted'`);
    }
  } catch (err: any) {
    console.warn(`[Startup] Failed to clear stale employee sessions: ${err.message}`);
  }

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
        return `🤖 *Alfred Status*\nRunning: ${managerService.isRunning() ? '✅' : '❌'}\nLoop: ${managerService.getLoopIntervalDisplay()}\nMode: ${managerService.getCommMode().toUpperCase()}`;
      }

      if (cmd === '/verbose') {
        managerService.setCommMode('verbose');
        return `📡 Mode: *VERBOSE* — I'll show you employee statuses, task descriptions, and messages in detail.`;
      }

      if (cmd === '/chat') {
        managerService.setCommMode('chat');
        return `📡 Mode: *CHAT* — I'll only send you my analysis and decisions. No raw employee data.`;
      }

      if (cmd === '/delete-alfred-memory') {
        const result = await managerService.wipeMemory(userId);
        managerService.restart();
        return result + '\n\n🔄 Alfred restarted fresh.';
      }

      // /apps — show all registered apps with inline buttons (Open + Share)
      if (cmd === '/apps') {
        const allApps = await infrastructureService.getAllApplications(userId);
        if (!allApps.length) return '📱 No applications registered yet.';

        const NGROK = 'https://nonshattering-adelaida-ponchoed.ngrok-free.dev';
        const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

        // Group by company
        const byCompany = new Map<string, typeof allApps>();
        for (const item of allApps) {
          if (!byCompany.has(item.companyName)) byCompany.set(item.companyName, []);
          byCompany.get(item.companyName)!.push(item);
        }

        let msg = '📱 *Applications*\n';
        const buttons: { text: string; callback_data?: string; url?: string }[][] = [];

        for (const [company, apps] of byCompany.entries()) {
          msg += `\n*${company}*\n`;
          for (const { app } of apps) {
            const cs = slugify(company);
            const as = slugify(app.name);
            const cookieSlug = `${cs}__${as}`;
            const appUrl = `${NGROK}/${cookieSlug}`;
            msg += `• ${app.name} (${app.type}:${app.port})\n`;
            buttons.push([
              { text: `🔗 ${app.name}`, url: appUrl },
              { text: `📤 Share`, callback_data: `share:${cookieSlug}` },
            ]);
          }
        }

        await telegramService.sendWithKeyboard(msg, buttons);
        return ''; // already sent via sendWithKeyboard
      }

      // /share <app-slug> — generate a one-time share link for a specific app
      if (cmd === '/share') {
        if (!args.trim()) return '⚠️ Usage: /share <app-slug>\nUse /apps to see available apps.';
        const shareToken = await firewallService.generateShareToken(args.trim());
        const NGROK = 'https://nonshattering-adelaida-ponchoed.ngrok-free.dev';
        const url = `${NGROK}/${args.trim()}?access=${shareToken}`;
        await telegramService.sendWithKeyboard(
          `🔗 *One-time share link for* \`${args.trim()}\`\n\nLink expires in 7 days and works only once.`,
          [[{ text: '📋 Copy Link', url }]],
        );
        return '';
      }

      // Everything else goes to the AI Manager — natural language
      const message = args ? `${cmd} ${args}`.trim() : cmd;
      return managerService.handleMessage(message, userId);
    };

    // Always register the handler (so setup screen can start polling later)
    // Only actually start polling if bot token is already configured
    // Register callback query handler for inline keyboard buttons (apps share, etc.)
    telegramService.setCallbackQueryHandler(async (data: string, callbackQueryId: string, _messageId: number) => {
      if (data.startsWith('share:')) {
        const appSlug = data.substring(6);
        const uId = await resolveUserId();
        if (!uId) { await telegramService.answerCallbackQuery(callbackQueryId, 'No user'); return; }
        const shareToken = await firewallService.generateShareToken(appSlug);
        const NGROK = 'https://nonshattering-adelaida-ponchoed.ngrok-free.dev';
        const url = `${NGROK}/${appSlug}?access=${shareToken}`;
        await telegramService.answerCallbackQuery(callbackQueryId, 'Share link generated!');
        await telegramService.sendWithKeyboard(
          `🔗 *One-time link for* \`${appSlug}\`\n\nExpires in 7 days. Works once.`,
          [[{ text: '🌐 Open / Share', url }]],
        );
      } else {
        await telegramService.answerCallbackQuery(callbackQueryId);
      }
    });

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

  // Start the heartbeat scheduler (recurring per-employee tasks)
  heartbeatService.start();

  // Start the firewall Telegram bot — gateway access approval
  firewallTelegramService.setCallbackHandler(async (action, requestId) => {
    if (action === 'approve') {
      const result = await firewallService.approve(requestId);
      if (!result) return { ok: false, reply: 'Request not found or already decided.' };
      return { ok: true, reply: `Access granted to ${result.visitorName}` };
    } else {
      const result = await firewallService.reject(requestId);
      if (!result) return { ok: false, reply: 'Request not found or already decided.' };
      return { ok: true, reply: `Access denied for ${result.visitorName}` };
    }
  });
  firewallTelegramService.startPolling();

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
    managerService.stop();
    telegramService.stopPolling();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Non-fatal errors that should NOT crash the server
  const NON_FATAL_ERRORS = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

  // Crash recovery — log and exit (resilient runner will restart)
  process.on('uncaughtException', (err: any) => {
    if (NON_FATAL_ERRORS.has(err.code) || NON_FATAL_ERRORS.has(err.message?.split(':')[0])) {
      console.warn(`[WARN] Non-fatal error (ignored): ${err.code || err.message}`);
      return;
    }
    console.error('[FATAL] Uncaught exception:', err.message);
    console.error(err.stack);
    telegramService.send(`🚨 *Server crashed:* ${err.message.substring(0, 200)}\n_Restarting..._`).catch(() => {});
    // Give Telegram message time to send, then exit so resilient runner restarts
    setTimeout(() => process.exit(1), 2000);
  });

  process.on('unhandledRejection', (reason: any) => {
    const msg = reason?.message || String(reason);
    const code = reason?.code;
    if (NON_FATAL_ERRORS.has(code) || NON_FATAL_ERRORS.has(msg?.split(':')[0])) {
      console.warn(`[WARN] Non-fatal rejection (ignored): ${code || msg}`);
      return;
    }
    console.error('[FATAL] Unhandled rejection:', msg);
    if (reason?.stack) console.error(reason.stack);
    telegramService.send(`🚨 *Unhandled rejection:* ${msg.substring(0, 200)}\n_Restarting..._`).catch(() => {});
    setTimeout(() => process.exit(1), 2000);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
