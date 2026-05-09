import https from 'https';

/**
 * Standalone Telegram service for the firewall bot.
 *
 * Separate from the main TelegramService so it has its own bot token, polling
 * loop, and chat id binding. Supports inline keyboards + callback_query handling
 * (which the main bot does not, by design).
 *
 * The bot token is `process.env.FIREWALL_BOT_TOKEN`. Chat id is auto-detected
 * on the first /start message (or read from `FIREWALL_CHAT_ID`).
 */

const LOG_PREFIX = '[FirewallTelegram]';

type CallbackHandler = (action: 'approve' | 'reject', requestId: string) => Promise<{ ok: boolean; reply: string }>;

export class FirewallTelegramService {
  private botToken: string;
  private chatId: string;
  private lastUpdateId = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private callbackHandler: CallbackHandler | null = null;

  constructor() {
    this.botToken = process.env.FIREWALL_BOT_TOKEN || '';
    this.chatId = process.env.FIREWALL_CHAT_ID || '';
  }

  get isConfigured(): boolean {
    return !!this.botToken;
  }

  /** Register the handler invoked when an Approve/Decline button is pressed */
  setCallbackHandler(handler: CallbackHandler): void {
    this.callbackHandler = handler;
  }

  startPolling(): void {
    if (!this.botToken) {
      console.log(`${LOG_PREFIX} FIREWALL_BOT_TOKEN not set — skipping`);
      return;
    }
    if (this.pollInterval) return;
    console.log(`${LOG_PREFIX} Bot polling started`);
    this.pollInterval = setInterval(() => this.pollUpdates().catch(() => {}), 2000);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Send an approval-request message with inline Approve/Decline buttons.
   * Returns the Telegram message_id so we can edit it after a decision.
   */
  async sendApprovalRequest(name: string, ip: string, ua: string, requestId: string): Promise<number | null> {
    if (!this.botToken || !this.chatId) {
      console.log(`${LOG_PREFIX} Cannot send — bot token or chat id missing`);
      return null;
    }

    const text = `🔐 *Access request*\n\n*Name:* ${this.escapeMd(name)}\n*IP:* \`${this.escapeMd(ip || 'unknown')}\`\n*User-Agent:* \`${this.escapeMd((ua || '').substring(0, 100))}\`\n\nApprove access?`;

    const result = await this.apiCall('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `firewall:approve:${requestId}` },
          { text: '❌ Decline', callback_data: `firewall:reject:${requestId}` },
        ]],
      },
    });

    if (result?.ok && result?.result?.message_id) {
      return result.result.message_id;
    }
    console.log(`${LOG_PREFIX} sendApprovalRequest failed:`, result?.description || 'unknown');
    return null;
  }

  /** Edit the original approval message after a decision (removes buttons + shows verdict) */
  async editMessageAfterDecision(messageId: number, decisionText: string): Promise<void> {
    if (!this.botToken || !this.chatId || !messageId) return;
    await this.apiCall('editMessageText', {
      chat_id: this.chatId,
      message_id: messageId,
      text: decisionText,
      parse_mode: 'Markdown',
    });
  }

  /** Send a plain text message (for /start replies, errors, etc.) */
  async send(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    await this.apiCall('sendMessage', { chat_id: this.chatId, text, parse_mode: 'Markdown' });
  }

  // ── Polling ──

  private async pollUpdates(): Promise<void> {
    const data = await this.apiGet('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: 1,
      limit: 10,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    });
    if (!data?.result?.length) return;

    for (const update of data.result) {
      this.lastUpdateId = update.update_id;

      // Handle button presses
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
        continue;
      }

      // Handle plain text messages — only for /start (chat id binding)
      const msg = update.message;
      if (!msg) continue;
      const fromChatId = String(msg.chat?.id || '');
      const text = msg.text || '';

      if (!this.chatId || text === '/start') {
        this.chatId = fromChatId;
        console.log(`${LOG_PREFIX} Chat ID auto-detected: ${this.chatId}`);
        await this.send(`🔐 *Firewall bot* connected!\nThis bot will send you access requests for the Alfred gateway.\nApprove/Decline with the inline buttons.`);
      }
    }
  }

  private async handleCallbackQuery(cb: any): Promise<void> {
    const data: string = cb?.data || '';
    const callbackId = cb?.id;
    const messageId = cb?.message?.message_id;
    const fromChatId = String(cb?.message?.chat?.id || '');

    if (!data.startsWith('firewall:')) {
      await this.answerCallback(callbackId, 'Unknown action');
      return;
    }
    if (this.chatId && fromChatId !== this.chatId) {
      await this.answerCallback(callbackId, 'Not authorized');
      return;
    }
    if (!this.callbackHandler) {
      await this.answerCallback(callbackId, 'Handler not registered');
      return;
    }

    const [, action, requestId] = data.split(':');
    if (action !== 'approve' && action !== 'reject') {
      await this.answerCallback(callbackId, 'Unknown action');
      return;
    }

    try {
      const result = await this.callbackHandler(action, requestId);
      await this.answerCallback(callbackId, result.reply, !result.ok);

      // Edit the original message to show the verdict + remove buttons
      if (messageId) {
        const verdict = action === 'approve' ? '✅ *Approved*' : '❌ *Rejected*';
        await this.editMessageAfterDecision(
          messageId,
          `${verdict}\n\n${result.reply}`
        );
      }
    } catch (err: any) {
      console.error(`${LOG_PREFIX} Callback handler error:`, err.message);
      await this.answerCallback(callbackId, 'Internal error', true);
    }
  }

  private async answerCallback(callbackQueryId: string, text: string, alert = false): Promise<void> {
    if (!callbackQueryId) return;
    await this.apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text.substring(0, 200),
      show_alert: alert,
    });
  }

  // ── Low-level API helpers ──

  private apiCall(method: string, params: any): Promise<any> {
    return new Promise((resolve) => {
      if (!this.botToken) return resolve({ ok: false, description: 'no token' });

      const body = JSON.stringify(params);
      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
        });
      });

      req.on('error', () => resolve({ ok: false }));
      req.write(body);
      req.end();
    });
  }

  private apiGet(method: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve) => {
      if (!this.botToken) return resolve({ ok: false });

      const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.botToken}/${method}?${query}`,
        method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
        });
      });

      req.on('error', () => resolve({ ok: false }));
      req.end();
    });
  }

  private escapeMd(text: string): string {
    return (text || '').replace(/([_*`[\]])/g, '\\$1');
  }
}

export const firewallTelegramService = new FirewallTelegramService();
