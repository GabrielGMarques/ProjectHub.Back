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

  private static readonly MAX_LEN = 4000; // Telegram limit is 4096, leave margin

  async send(message: string): Promise<boolean> {
    if (!this.botToken) return false;
    if (!this.chatId) {
      console.log('[Telegram] No chat ID set. Send /start to the bot in Telegram to connect.');
      return false;
    }

    // Split into chunks that fit Telegram's limit
    const chunks = TelegramService.splitMessage(message, TelegramService.MAX_LEN);
    let allOk = true;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Convert standard MD → Telegram Markdown, add part indicator
      const converted = TelegramService.toTelegramMarkdown(chunk);
      const text = chunks.length > 1 ? `${converted}\n\n_(${i + 1}/${chunks.length})_` : converted;

      // Try Markdown first
      let result = await this.apiCallWithResponse('sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      // If Markdown failed (often bad formatting from AI), retry as plain text
      if (!result.ok) {
        console.log(`[Telegram] Markdown send failed (${result.errorCode}: ${result.description}), retrying as plain text`);
        const plainText = TelegramService.stripMarkdown(text);
        result = await this.apiCallWithResponse('sendMessage', {
          chat_id: this.chatId,
          text: plainText,
          disable_web_page_preview: true,
        });

        if (!result.ok) {
          console.log(`[Telegram] Plain text send also failed (${result.errorCode}: ${result.description}), chunk ${i + 1}/${chunks.length}`);
          allOk = false;
        }
      }

      // Small delay between chunks to avoid rate limits
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    return allOk;
  }

  /** Split a long message into chunks, breaking at paragraph/line boundaries */
  private static splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Try to split at double newline (paragraph)
      let splitAt = remaining.lastIndexOf('\n\n', maxLen);
      // Fallback: single newline
      if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('\n', maxLen);
      // Fallback: space
      if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(' ', maxLen);
      // Hard cut as last resort
      if (splitAt < maxLen * 0.3) splitAt = maxLen;

      chunks.push(remaining.substring(0, splitAt).trimEnd());
      remaining = remaining.substring(splitAt).trimStart();
    }

    return chunks.filter(c => c.length > 0);
  }

  /** Convert standard Markdown to Telegram-compatible Markdown */
  private static toTelegramMarkdown(text: string): string {
    return text
      // **bold** → *bold* (Telegram uses single asterisk for bold)
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // ## Heading → *Heading* (Telegram has no headings, make bold)
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // [text](url) → text (url) — Telegram Markdown doesn't support links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      // --- or === horizontal rules → just dashes
      .replace(/^[-=]{3,}$/gm, '———');
  }

  /** Strip Markdown formatting so plain text still reads well */
  private static stripMarkdown(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')  // bold **text**
      .replace(/\*(.*?)\*/g, '$1')       // bold/italic *text*
      .replace(/_(.*?)_/g, '$1')         // italic _text_
      .replace(/`([^`]+)`/g, '$1')       // inline code
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim()); // code blocks
  }

  async notifyTaskStarted(name: string, project: string, task: string): Promise<void> {
    await this.send(`🟢 *${name}* started working\n🏢 ${project}\n📝 ${task}`);
  }

  async notifyTaskCompleted(name: string, project: string, task: string): Promise<void> {
    await this.send(`✅ *${name}* completed\n🏢 ${project}\n📝 ${task}`);
  }

  async notifyTaskFailed(name: string, project: string, task: string, err: string): Promise<void> {
    await this.send(`❌ *${name}* failed\n🏢 ${project}\n📝 ${task}\n⚠️ ${err}`);
  }

  async notifyHired(name: string, project: string): Promise<void> {
    await this.send(`🤝 *${name}* hired\n🏢 ${project}`);
  }

  async notifyFired(name: string, project: string): Promise<void> {
    await this.send(`👋 *${name}* removed\n🏢 ${project}`);
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

        // Handle document/photo messages — download and extract text
        const doc = update.message?.document;
        const photo = update.message?.photo;
        let text: string | undefined = update.message?.text;
        const caption = update.message?.caption || '';

        if (!text && (doc || photo)) {
          const result = await this.handleFileMessage(update.message, fromChatId);
          if (result) {
            text = result;
          } else {
            continue;
          }
        }

        // Handle voice/audio messages — transcribe to text
        const voiceFileId = update.message?.voice?.file_id
          || update.message?.audio?.file_id
          || update.message?.video_note?.file_id;
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
          msg += `${statusIcon} ${e.avatar} *${e.name}* — ${e.title}\n   🏢 ${pName} | Tasks: ${e.taskHistory.length}\n`;
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
          msg += `${e.avatar} *${e.name}*\n   🏢 ${pName}\n   📝 ${task?.description || 'Unknown task'}\n\n`;
        }
        return msg;
      }

      case '/idle': {
        const idle = await Employee.find({ userId, status: 'idle' }).populate('projectId', 'name');
        if (!idle.length) return '🏃 Everyone is working!';

        let msg = `⚪ *Idle Employees*\n\n`;
        for (const e of idle) {
          const pName = (e.projectId as any)?.name || 'Unknown';
          msg += `${e.avatar} *${e.name}* — ${e.title}\n   🏢 ${pName}\n`;
        }
        return msg;
      }

      case '/companies':
      case '/projects': {
        const projects = await Project.find({ userId });
        if (!projects.length) return '🏢 No companies yet.';

        let msg = `🏢 *Companies*\n\n`;
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
        language: 'en',
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

  // ── File handling ──

  /** Files directory for Alfred */
  private static get filesDir(): string {
    const dir = path.resolve(__dirname, '../../../ManagerMemory/files');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Handle an incoming document or photo message — download, extract text, return prompt */
  private async handleFileMessage(message: any, chatId: string): Promise<string | null> {
    const doc = message.document;
    const photo = message.photo;
    const caption = message.caption || '';

    try {
      let fileId: string;
      let fileName: string;

      if (doc) {
        fileId = doc.file_id;
        fileName = doc.file_name || `doc-${Date.now()}`;
      } else if (photo?.length) {
        // Telegram sends multiple sizes — take the largest
        const largest = photo[photo.length - 1];
        fileId = largest.file_id;
        fileName = `photo-${Date.now()}.jpg`;
      } else {
        return null;
      }

      // Get file path from Telegram
      const fileInfo = await this.apiGet('getFile', { file_id: fileId });
      const filePath = fileInfo?.result?.file_path;
      if (!filePath) {
        await this.apiCall('sendMessage', { chat_id: chatId, text: '⚠️ Could not get file from Telegram.' });
        return null;
      }

      // Download to ManagerMemory/files/
      const ext = path.extname(fileName) || path.extname(filePath) || '';
      const safeFileName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const destPath = path.join(TelegramService.filesDir, safeFileName);
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      await this.downloadFile(fileUrl, destPath);

      const fileSize = fs.statSync(destPath).size;
      console.log(`[Telegram] File downloaded: ${safeFileName} (${fileSize} bytes)`);

      const lowerExt = ext.toLowerCase();

      // PDF — extract text
      if (lowerExt === '.pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const buffer = fs.readFileSync(destPath);
          const data = await pdfParse(buffer);
          const textContent = (data.text || '').substring(0, 15000);
          const pageCount = data.numpages || 0;

          await this.apiCall('sendMessage', {
            chat_id: chatId,
            text: `📄 _PDF received: ${fileName} (${pageCount} pages)_`,
            parse_mode: 'Markdown',
          });

          // Save extracted text alongside the PDF for Alfred to reference later
          const txtPath = destPath.replace(/\.pdf$/i, '.txt');
          fs.writeFileSync(txtPath, `Extracted from: ${fileName}\nPages: ${pageCount}\n\n${data.text || ''}`, 'utf-8');

          return caption
            ? `[Bruce sent a PDF: "${fileName}" (${pageCount} pages)] ${caption}\n\nPDF CONTENT:\n${textContent}`
            : `[Bruce sent a PDF: "${fileName}" (${pageCount} pages)]\n\nPDF CONTENT:\n${textContent}`;
        } catch (err: any) {
          console.log(`[Telegram] PDF parse failed: ${err.message}`);
          await this.apiCall('sendMessage', {
            chat_id: chatId,
            text: `📄 _PDF saved but could not extract text: ${fileName}_`,
            parse_mode: 'Markdown',
          });
          return caption
            ? `[Bruce sent a PDF: "${fileName}" — text extraction failed. File saved at: ${destPath}] ${caption}`
            : `[Bruce sent a PDF: "${fileName}" — text extraction failed. File saved at: ${destPath}]`;
        }
      }

      // Text files — read directly
      if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.yml', '.yaml', '.log'].includes(lowerExt)) {
        const content = fs.readFileSync(destPath, 'utf-8').substring(0, 15000);
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: `📄 _File received: ${fileName}_`,
          parse_mode: 'Markdown',
        });
        return caption
          ? `[Bruce sent a file: "${fileName}"] ${caption}\n\nFILE CONTENT:\n${content}`
          : `[Bruce sent a file: "${fileName}"]\n\nFILE CONTENT:\n${content}`;
      }

      // Images — save and reference
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(lowerExt)) {
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: `🖼️ _Image saved: ${fileName}_`,
          parse_mode: 'Markdown',
        });
        return caption
          ? `[Bruce sent an image: "${fileName}", saved at: ${destPath}] ${caption}`
          : `[Bruce sent an image: "${fileName}", saved at: ${destPath}]`;
      }

      // Other files — just save
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: `📎 _File saved: ${fileName}_`,
        parse_mode: 'Markdown',
      });
      return caption
        ? `[Bruce sent a file: "${fileName}", saved at: ${destPath}] ${caption}`
        : `[Bruce sent a file: "${fileName}", saved at: ${destPath}]`;

    } catch (err: any) {
      console.log(`[Telegram] File handling failed: ${err.message}`);
      await this.apiCall('sendMessage', { chat_id: chatId, text: `⚠️ Failed to process file: ${err.message}` });
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
    return this.apiCallWithResponse(method, body).then(r => r.ok);
  }

  private apiCallWithResponse(method: string, body: any): Promise<{ ok: boolean; errorCode?: number; description?: string }> {
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
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ ok: true });
          } else {
            try {
              const parsed = JSON.parse(data);
              resolve({ ok: false, errorCode: parsed.error_code, description: parsed.description });
            } catch {
              resolve({ ok: false, errorCode: res.statusCode, description: data.substring(0, 200) });
            }
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, errorCode: 0, description: err.message }));
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
