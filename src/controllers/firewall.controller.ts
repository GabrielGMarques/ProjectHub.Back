import { Request, Response } from 'express';
import { firewallService } from '../services/firewall.service';

const COOKIE_NAME = 'firewall_token';
const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 3600 * 1000; // 10 years (effectively never)

export class FirewallController {
  /** POST /api/firewall/request — visitor submits the access form */
  async request(req: Request, res: Response): Promise<void> {
    try {
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || '';
      const ua = req.headers['user-agent'] || '';
      const result = await firewallService.requestAccess(name, ip, String(ua));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/firewall/status?requestId=xxx — polled by firewall.html */
  async status(req: Request, res: Response): Promise<void> {
    try {
      const requestId = String(req.query.requestId || '');
      const result = await firewallService.getStatus(requestId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/firewall/validate — called by nginx auth_request on every gateway request */
  async validate(req: Request, res: Response): Promise<void> {
    const cookies = (req as any).cookies || {};
    const token = cookies[COOKIE_NAME];
    // Pass the request IP so local/same-host IPs bypass the token check
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || '';
    const ok = await firewallService.validateToken(token, ip);
    if (ok) {
      res.status(200).end();
    } else {
      res.status(401).end();
    }
  }

  /** POST /api/firewall/set-cookie — called by firewall.html after polling sees approved */
  async setCookie(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.body || {};
      if (!token || typeof token !== 'string') {
        res.status(400).json({ error: 'token required' });
        return;
      }
      const ok = await firewallService.validateToken(token);
      if (!ok) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      res.cookie(COOKIE_NAME, token, {
        path: '/',
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE_MS,
        httpOnly: false, // JS needs to be able to detect presence
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** POST /api/firewall/share — generate a reusable share link for an app */
  async share(req: Request, res: Response): Promise<void> {
    try {
      const { appSlug } = req.body || {};
      if (!appSlug || typeof appSlug !== 'string') {
        res.status(400).json({ error: 'appSlug is required' });
        return;
      }
      const shareToken = await firewallService.generateShareToken(appSlug);
      const host = req.headers.host || 'nonshattering-adelaida-ponchoed.ngrok-free.dev';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const url = `${proto}://${host}/${appSlug}?access=${shareToken}`;
      res.json({ shareToken, url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** GET /api/firewall/access?token=xxx — consume a one-time share token, set cookies, redirect */
  async access(req: Request, res: Response): Promise<void> {
    try {
      const token = String(req.query.token || '');
      if (!token) {
        res.status(400).send('Missing access token');
        return;
      }
      const result = await firewallService.consumeShareToken(token);
      if (!result) {
        res.status(401).send('Invalid or expired access link. Request access at <a href="/__firewall">/__firewall</a>.');
        return;
      }
      // Set both cookies — firewall auth + app selection
      res.cookie(COOKIE_NAME, result.firewallToken, {
        path: '/',
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE_MS,
        httpOnly: false,
      });
      if (result.appSlug) {
        res.cookie('selected_app', result.appSlug, {
          path: '/',
          sameSite: 'lax',
          maxAge: COOKIE_MAX_AGE_MS,
          httpOnly: false,
        });
      }
      res.redirect('/');
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
