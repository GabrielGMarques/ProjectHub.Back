import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Employee } from '../models/employee.model';
import { Project } from '../models/project.model';

export class TelegramService {
  private botToken: string;
  private chatId: string;
  private lastUpdateId = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private commandHandler: ((cmd: string, args: string) => Promise<string>) | null = null;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
  }

  get isConfigured(): boolean {
    return !!this.botToken;
  }

  // ── Outbound (send) ──

  async send(message: string): Promise<boolean> {
    if (!this.botToken) return false;
    if (!this.chatId) {
      console.log('[Telegram] No chat ID set. Send /start to the bot in Telegram to connect.');
      return false;
    }
    const ok = await this.apiCall('sendMessage', {
      chat_id: this.chatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    if (!ok) {
      console.log(`[Telegram] Failed to send message to chat ${this.chatId}`);
    }
    return ok;
  }

  async notifyTaskStarted(name: string, project: string, task: string): Promise<void> {
    await this.send(`🟢 *${name}* started working\n📁 ${project}\n📝 ${task}`);
  }

  async notifyTaskCompleted(name: string, project: string, task: string): Promise<void> {
    await this.send(`✅ *${name}* completed\n📁 ${project}\n📝 ${task}`);
  }

  async notifyTaskFailed(name: string, project: string, task: string, err: string): Promise<void> {
    await this.send(`❌ *${name}* failed\n📁 ${project}\n📝 ${task}\n⚠️ ${err}`);
  }

  async notifyHired(name: string, project: string): Promise<void> {
    await this.send(`🤝 *${name}* hired\n📁 ${project}`);
  }

  async notifyFired(name: string, project: string): Promise<void> {
    await this.send(`👋 *${name}* removed\n📁 ${project}`);
  }

  /** Try to discover the chat ID by reading recent messages sent to the bot.
   *  Stops polling first to avoid race conditions, reads ALL pending updates. */
  async discoverChatId(): Promise<{ chatId: string; username: string } | null> {
    if (!this.botToken) return null;

    // Pause polling so it doesn't consume updates before we read them
    const wasPolling = !!this.pollInterval;
    if (wasPolling) this.stopPolling();

    // Read without offset to get all pending updates
    const data = await this.apiGet('getUpdates', { limit: 100, timeout: 2 });

    if (!data?.result?.length) {
      // Resume polling if it was running
      if (wasPolling && this.commandHandler) this.startPolling(this.commandHandler);
      return null;
    }

    // Find the most recent message with a chat id
    for (let i = data.result.length - 1; i >= 0; i--) {
      const msg = data.result[i].message;
      if (msg?.chat?.id) {
        // Acknowledge all updates so poller doesn't re-process them
        this.lastUpdateId = data.result[data.result.length - 1].update_id;
        // Resume polling
        if (wasPolling && this.commandHandler) this.startPolling(this.commandHandler);
        return {
          chatId: String(msg.chat.id),
          username: msg.chat.username || msg.chat.first_name || '',
        };
      }
    }
    // Resume polling
    if (wasPolling && this.commandHandler) this.startPolling(this.commandHandler);
    return null;
  }

  setBotToken(token: string): void {
    this.botToken = token;
  }

  setChatId(chatId: string): void {
    this.chatId = chatId;
  }

  getChatId(): string {
    return this.chatId;
  }

  // ── Inbound (polling) ──

  getCommandHandler(): ((cmd: string, args: string) => Promise<string>) | null {
    return this.commandHandler;
  }

  startPolling(handler: (cmd: string, args: string) => Promise<string>): void {
    if (!this.botToken || this.pollInterval) return;
    this.commandHandler = handler;
    console.log('[Telegram] Bot polling started');

    this.pollInterval = setInterval(() => this.pollUpdates(), 2000);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private processing = false;
  private messageQueue: { text: string; chatId: string }[] = [];

  private async pollUpdates(): Promise<void> {
    try {
      const data = await this.apiGet('getUpdates', { offset: this.lastUpdateId + 1, timeout: 1, limit: 10 });
      if (!data?.result?.length) return;

      for (const update of data.result) {
        this.lastUpdateId = update.update_id;
        const fromChatId = String(update.message?.chat?.id);

        // Handle voice/audio messages — transcribe to text
        const voiceFileId = update.message?.voice?.file_id
          || update.message?.audio?.file_id
          || update.message?.video_note?.file_id;
        let text: string | undefined = update.message?.text;
        if (!text && voiceFileId) {
          const transcribed = await this.transcribeVoice(voiceFileId);
          if (transcribed) {
            text = transcribed;
            await this.apiCall('sendMessage', {
              chat_id: fromChatId,
              text: `🎙️ _"${transcribed.substring(0, 200)}${transcribed.length > 200 ? '...' : ''}"_`,
              parse_mode: 'Markdown',
            });
          } else {
            await this.apiCall('sendMessage', {
              chat_id: fromChatId,
              text: '⚠️ Could not transcribe audio. Check server logs for details.',
              parse_mode: 'Markdown',
            });
            continue;
          }
        }

        if (!text) continue;

        // Auto-detect chat ID from first incoming message
        if (!this.chatId || text === '/start') {
          this.chatId = fromChatId;
          console.log(`[Telegram] Chat ID auto-detected: ${this.chatId}`);
          await this.send('🤖 *ProjectsHub Bot* connected!\nYour chat ID: `' + this.chatId + '`\nType /help for commands.');
          continue;
        }

        if (fromChatId !== this.chatId) continue;

        // Queue the message for non-blocking processing
        this.messageQueue.push({ text, chatId: fromChatId });
      }

      // Process queue (non-blocking — one at a time)
      this.processQueue();
    } catch { /* polling error — will retry */ }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    this.processing = true;

    while (this.messageQueue.length > 0) {
      const { text } = this.messageQueue.shift()!;

      if (!this.commandHandler) continue;

      // Parse command format
      const isCmd = text.startsWith('/');
      const spaceIdx = text.indexOf(' ');
      const cmd = isCmd ? (spaceIdx > 0 ? text.substring(0, spaceIdx) : text).toLowerCase() : text;
      const args = isCmd && spaceIdx > 0 ? text.substring(spaceIdx + 1).trim() : (isCmd ? '' : text);

      // Send "thinking" indicator immediately so the user knows we're alive
      await this.send('💭 _Processing..._');

      try {
        const reply = await this.commandHandler(cmd, isCmd ? args : '');
        if (reply) await this.send(reply);
      } catch (err: any) {
        await this.send(`⚠️ Error: ${err.message}`);
      }
    }

    this.processing = false;
  }

  // ── Built-in command handlers ──

  static async handleCommand(cmd: string, args: string, userId: string): Promise<string> {
    switch (cmd) {
      case '/help':
        return `🤖 *ProjectsHub Bot Commands*

/status — All projects & employees overview
/digest — Daily todos digest (sent automatically at 9 AM)
/employees — List all hired employees
/working — Employees currently working
/idle — Idle employees
/projects — List all projects
/summary — Summary of a project (use: /summary ProjectName)
/hire — Hire (use: /hire ProjectName role)
/fire — Fire (use: /fire EmployeeName)
/comms — Recent comms (use: /comms ProjectName)
/help — This message`;

      case '/status': {
        const projects = await Project.find({ userId });
        const employees = await Employee.find({ userId });
        const working = employees.filter(e => e.status === 'working').length;
        const idle = employees.filter(e => e.status === 'idle').length;

        let msg = `📊 *Status Overview*\n\n`;
        msg += `📁 Projects: ${projects.length}\n`;
        msg += `👥 Employees: ${employees.length} (${working} working, ${idle} idle)\n\n`;

        for (const p of projects) {
          const pEmps = employees.filter(e => e.projectId.toString() === p._id.toString());
          const pWorking = pEmps.filter(e => e.status === 'working').length;
          msg += `*${p.name}* — ${pEmps.length} employees`;
          if (pWorking > 0) msg += ` (${pWorking} working)`;
          msg += `\n`;
        }
        return msg;
      }

      case '/employees': {
        const employees = await Employee.find({ userId }).populate('projectId', 'name');
        if (!employees.length) return '👥 No employees hired yet.';

        let msg = `👥 *All Employees*\n\n`;
        for (const e of employees) {
          const pName = (e.projectId as any)?.name || 'Unknown';
          const statusIcon = e.status === 'working' ? '🟢' : e.status === 'paused' ? '🟡' : '⚪';
          msg += `${statusIcon} ${e.avatar} *${e.name}* — ${e.title}\n   📁 ${pName} | Tasks: ${e.taskHistory.length}\n`;
        }
        return msg;
      }

      case '/working': {
        const working = await Employee.find({ userId, status: 'working' }).populate('projectId', 'name');
        if (!working.length) return '😴 No employees currently working.';

        let msg = `🟢 *Working Employees*\n\n`;
        for (const e of working) {
          const pName = (e.projectId as any)?.name || 'Unknown';
          const task = e.taskHistory.find(t => t.status === 'in_progress');
          msg += `${e.avatar} *${e.name}*\n   📁 ${pName}\n   📝 ${task?.description || 'Unknown task'}\n\n`;
        }
        return msg;
      }

      case '/idle': {
        const idle = await Employee.find({ userId, status: 'idle' }).populate('projectId', 'name');
        if (!idle.length) return '🏃 Everyone is working!';

        let msg = `⚪ *Idle Employees*\n\n`;
        for (const e of idle) {
          const pName = (e.projectId as any)?.name || 'Unknown';
          msg += `${e.avatar} *${e.name}* — ${e.title}\n   📁 ${pName}\n`;
        }
        return msg;
      }

      case '/projects': {
        const projects = await Project.find({ userId });
        if (!projects.length) return '📁 No projects yet.';

        let msg = `📁 *Projects*\n\n`;
        for (const p of projects) {
          const empCount = await Employee.countDocuments({ projectId: p._id, userId });
          msg += `*${p.name}*\n   ${p.description || 'No description'}\n   👥 ${empCount} employees | 💰 $${p.mrr || 0} MRR\n\n`;
        }
        return msg;
      }

      case '/summary': {
        if (!args) return '⚠️ Usage: /summary ProjectName';
        const project = await Project.findOne({ userId, name: { $regex: new RegExp(args, 'i') } });
        if (!project) return `⚠️ Project "${args}" not found.`;

        const emps = await Employee.find({ userId, projectId: project._id });
        const working = emps.filter(e => e.status === 'working');
        const totalTasks = emps.reduce((s, e) => s + e.taskHistory.length, 0);
        const completedTasks = emps.reduce((s, e) => s + e.taskHistory.filter(t => t.status === 'completed').length, 0);

        let msg = `📁 *${project.name}*\n`;
        msg += `${project.description || ''}\n\n`;
        msg += `💰 MRR: $${project.mrr || 0}\n`;
        msg += `👥 Employees: ${emps.length} (${working.length} working)\n`;
        msg += `📝 Tasks: ${completedTasks}/${totalTasks} completed\n\n`;

        if (emps.length) {
          msg += `*Team:*\n`;
          for (const e of emps) {
            const icon = e.status === 'working' ? '🟢' : '⚪';
            msg += `${icon} ${e.avatar} ${e.name} — ${e.title}\n`;
          }
        }
        return msg;
      }

      case '/hire': {
        if (!args) return '⚠️ Usage: /hire ProjectName role\nRoles: cto, tech-lead, product-manager, frontend-developer, backend-developer, fullstack-developer, ui-ux-designer, qa-engineer, devops-engineer, data-analyst, security-engineer, marketing-specialist';
        const parts = args.split(/\s+/);
        const role = parts.pop()!;
        const projectName = parts.join(' ');
        if (!projectName || !role) return '⚠️ Usage: /hire ProjectName role';

        const project = await Project.findOne({ userId, name: { $regex: new RegExp(projectName, 'i') } });
        if (!project) return `⚠️ Project "${projectName}" not found.`;

        // Delegate to employee service (imported at call site)
        return `__HIRE__${project._id}__${role}`;
      }

      case '/fire': {
        if (!args) return '⚠️ Usage: /fire EmployeeName';
        const emp = await Employee.findOne({ userId, name: { $regex: new RegExp(args, 'i') } });
        if (!emp) return `⚠️ Employee "${args}" not found.`;
        return `__FIRE__${emp._id}`;
      }

      case '/comms': {
        if (!args) return '⚠️ Usage: /comms ProjectName';
        const project = await Project.findOne({ userId, name: { $regex: new RegExp(args, 'i') } });
        if (!project) return `⚠️ Project "${args}" not found.`;
        return `__COMMS__${project._id}`;
      }

      default:
        return `❓ Unknown command: ${cmd}\nType /help for available commands.`;
    }
  }

  // ── Voice transcription ──

  /** Download a Telegram voice/audio file and transcribe via OpenAI Whisper */
  private async transcribeVoice(fileId: string): Promise<string | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log('[Telegram] Voice: OPENAI_API_KEY not set');
      return null;
    }

    let tmpFile = '';
    try {
      // 1. Get file path from Telegram
      const fileInfo = await this.apiGet('getFile', { file_id: fileId });
      const filePath = fileInfo?.result?.file_path;
      if (!filePath) {
        console.log('[Telegram] Voice: could not get file path from Telegram');
        return null;
      }
      console.log(`[Telegram] Voice: downloading ${filePath}`);

      // 2. Download the file to a temp location
      const ext = path.extname(filePath) || '.ogg';
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      tmpFile = path.join(os.tmpdir(), `tg_voice_${Date.now()}${ext}`);
      await this.downloadFile(fileUrl, tmpFile);

      const fileSize = fs.statSync(tmpFile).size;
      console.log(`[Telegram] Voice: downloaded ${fileSize} bytes to ${tmpFile}`);

      if (fileSize === 0) {
        console.log('[Telegram] Voice: downloaded file is empty');
        fs.unlinkSync(tmpFile);
        return null;
      }

      // 3. Transcribe with OpenAI Whisper
      const OpenAI = require('openai').default || require('openai');
      const openai = new OpenAI({ apiKey });
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpFile),
        model: 'whisper-1',
      });

      console.log(`[Telegram] Voice: transcribed "${(transcription.text || '').substring(0, 50)}..."`);

      // Cleanup
      fs.unlinkSync(tmpFile);
      return transcription.text || null;
    } catch (err: any) {
      console.log(`[Telegram] Voice transcription failed: ${err.message}`);
      if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      return null;
    }
  }

  /** Download a URL to a local file */
  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
  }

  // ── API helpers ──

  /** Public API get (for validation calls like getMe) */
  apiGetPublic(method: string, params: Record<string, any>): Promise<any> {
    return this.apiGet(method, params);
  }

  private apiCall(method: string, body: any): Promise<boolean> {
    return new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  private apiGet(method: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve) => {
      const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}?${qs}`,
        method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  // Singleton
  private static _instance: TelegramService;
  static getInstance(): TelegramService {
    if (!TelegramService._instance) {
      TelegramService._instance = new TelegramService();
    }
    return TelegramService._instance;
  }
}

/** Shared singleton — use this everywhere instead of `new TelegramService()` */
export const telegramBot = TelegramService.getInstance();
