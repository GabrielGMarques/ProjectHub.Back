import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { TelegramService, telegramBot } from '../services/telegram.service';
import fs from 'fs';
import path from 'path';

const telegramService = telegramBot;

export class TelegramController {

  async getStatus(_req: AuthRequest, res: Response): Promise<void> {
    res.json({
      configured: telegramService.isConfigured,
      chatId: telegramService.getChatId(),
      botToken: telegramService.isConfigured ? '***configured***' : '',
    });
  }

  async discover(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await telegramService.discoverChatId();
      if (result) {
        res.json({ found: true, chatId: result.chatId, username: result.username });
      } else {
        res.json({ found: false });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Full setup flow:
   * 1. Takes botToken
   * 2. Sets it on the service
   * 3. Polls getUpdates to find chat ID
   * 4. Sets chat ID
   * 5. Sends a test message
   * 6. Saves to .env
   */
  async setup(req: AuthRequest, res: Response): Promise<void> {
    const { botToken } = req.body;
    if (!botToken) { res.status(400).json({ error: 'botToken is required' }); return; }

    // Set the token
    telegramService.setBotToken(botToken);

    // Step 1: Validate the token by calling getMe
    try {
      const me = await telegramService.apiGetPublic('getMe', {});
      if (!me?.ok) {
        res.json({ step: 'error', message: `Invalid bot token. Telegram responded: ${JSON.stringify(me?.description || me)}` });
        return;
      }
      console.log(`[Telegram] Token valid — bot: @${me.result?.username}`);
    } catch (err: any) {
      res.json({ step: 'error', message: `Could not validate token: ${err.message}` });
      return;
    }

    // Step 2: Try to discover chat ID from recent messages
    try {
      const discovery = await telegramService.discoverChatId();
      if (!discovery) {
        res.json({
          step: 'waiting',
          message: 'Token is valid! Now open your bot in Telegram and send /start, then click "Connect Bot" again.',
        });
        return;
      }

      // Step 3: Set chat ID and send test message
      telegramService.setChatId(discovery.chatId);
      const ok = await telegramService.send(`✅ *ProjectsHub connected!*\nHello ${discovery.username}! Type /help for commands.`);

      if (!ok) {
        res.json({ step: 'error', message: `Found chat ${discovery.chatId} but failed to send. The bot may not have permission to message this chat.` });
        return;
      }

      // Step 4: Save to .env
      this.saveToEnv(botToken, discovery.chatId);

      // Step 5: Start polling if a command handler was registered (from server.ts)
      const handler = telegramService.getCommandHandler();
      if (handler) {
        telegramService.startPolling(handler);
      }

      res.json({
        step: 'complete',
        chatId: discovery.chatId,
        username: discovery.username,
        message: `Connected to ${discovery.username}! Test message sent.`,
      });
    } catch (err: any) {
      res.json({ step: 'error', message: `Discovery failed: ${err.message}` });
    }
  }

  async testSend(req: AuthRequest, res: Response): Promise<void> {
    const chatId = req.body.chatId || telegramService.getChatId();
    if (!chatId) {
      res.status(400).json({ error: 'No chat ID configured.' });
      return;
    }
    const oldChatId = telegramService.getChatId();
    telegramService.setChatId(chatId);
    const ok = await telegramService.send('✅ *Test message from ProjectsHub!*\nTelegram integration is working.');
    telegramService.setChatId(oldChatId);

    res.json({ success: ok, message: ok ? 'Message sent!' : 'Failed to send.' });
  }

  private saveToEnv(botToken: string, chatId: string): void {
    try {
      // Try multiple possible locations
      const candidates = [
        path.join(process.cwd(), '.env'),
        path.join(__dirname, '../../.env'),
        path.join(__dirname, '../../../.env'),
      ];
      const envPath = candidates.find(p => fs.existsSync(p));
      if (!envPath) return;

      let content = fs.readFileSync(envPath, 'utf-8');

      if (content.includes('TELEGRAM_BOT_TOKEN=')) {
        content = content.replace(/TELEGRAM_BOT_TOKEN=.*/g, `TELEGRAM_BOT_TOKEN=${botToken}`);
      } else {
        content += `\nTELEGRAM_BOT_TOKEN=${botToken}`;
      }

      if (content.includes('TELEGRAM_CHAT_ID=')) {
        content = content.replace(/TELEGRAM_CHAT_ID=.*/g, `TELEGRAM_CHAT_ID=${chatId}`);
      } else {
        content += `\nTELEGRAM_CHAT_ID=${chatId}`;
      }

      fs.writeFileSync(envPath, content, 'utf-8');
    } catch { /* non-critical */ }
  }
}
