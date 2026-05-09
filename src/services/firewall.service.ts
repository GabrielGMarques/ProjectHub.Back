import { randomUUID } from 'crypto';
import os from 'os';
import { FirewallToken } from '../models/firewall-token.model';
import { firewallTelegramService } from './firewall-telegram.service';

const LOG_PREFIX = '[Firewall]';

/** Collect all local IPs (IPv4 + IPv6) at startup so we can auto-approve requests from our own machine */
function getLocalIps(): Set<string> {
  const ips = new Set<string>(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      ips.add(iface.address);
      // Also add the IPv4-mapped IPv6 form (::ffff:x.x.x.x)
      if (iface.family === 'IPv4') {
        ips.add(`::ffff:${iface.address}`);
      }
    }
  }
  return ips;
}

const LOCAL_IPS = getLocalIps();

export class FirewallService {
  /** Check if an IP belongs to the host machine */
  isLocalIp(ip: string): boolean {
    if (!ip) return false;
    return LOCAL_IPS.has(ip.trim());
  }

  /** Visitor submits the request form on /__firewall */
  async requestAccess(name: string, ip: string, ua: string): Promise<{ requestId: string; autoApproved?: boolean; token?: string }> {
    const requestId = randomUUID();
    const safeName = (name || '').trim().substring(0, 80) || 'Anonymous';

    // Auto-approve if the request comes from the same machine
    if (this.isLocalIp(ip)) {
      const token = randomUUID();
      await FirewallToken.create({
        requestId,
        token,
        visitorName: safeName,
        visitorIp: ip || '',
        visitorUserAgent: ua || '',
        status: 'approved',
        approvedAt: new Date(),
      });
      console.log(`${LOG_PREFIX} Auto-approved (local IP ${ip}): ${safeName}`);
      return { requestId, autoApproved: true, token };
    }

    const row = await FirewallToken.create({
      requestId,
      visitorName: safeName,
      visitorIp: ip || '',
      visitorUserAgent: ua || '',
      status: 'pending',
    });

    console.log(`${LOG_PREFIX} New access request: ${safeName} (${requestId.substring(0, 8)}...)`);

    const messageId = await firewallTelegramService.sendApprovalRequest(safeName, ip, ua, requestId);
    if (messageId) {
      row.telegramMessageId = messageId;
      await row.save();
    } else {
      console.warn(`${LOG_PREFIX} Telegram message failed — visitor will see waiting state, manual DB approval needed`);
    }

    return { requestId };
  }

  /** Approve via Telegram callback */
  async approve(requestId: string): Promise<{ token: string; visitorName: string } | null> {
    const row = await FirewallToken.findOne({ requestId });
    if (!row) return null;
    if (row.status !== 'pending') {
      console.log(`${LOG_PREFIX} approve: row already ${row.status}, ignoring`);
      return null;
    }

    row.status = 'approved';
    row.approvedAt = new Date();
    row.token = randomUUID();
    await row.save();

    console.log(`${LOG_PREFIX} Approved: ${row.visitorName} (token ...${row.token.substring(row.token.length - 6)})`);
    return { token: row.token, visitorName: row.visitorName };
  }

  /** Reject via Telegram callback */
  async reject(requestId: string): Promise<{ visitorName: string } | null> {
    const row = await FirewallToken.findOne({ requestId });
    if (!row) return null;
    if (row.status !== 'pending') {
      console.log(`${LOG_PREFIX} reject: row already ${row.status}, ignoring`);
      return null;
    }

    row.status = 'rejected';
    row.rejectedAt = new Date();
    await row.save();

    console.log(`${LOG_PREFIX} Rejected: ${row.visitorName}`);
    return { visitorName: row.visitorName };
  }

  /** Used by nginx auth_request — validates the firewall_token cookie value.
   *  Also accepts an optional IP: if it's a local IP, skip the token check entirely. */
  async validateToken(token: string, requestIp?: string): Promise<boolean> {
    // Same-host IPs always pass — no cookie needed
    if (requestIp && this.isLocalIp(requestIp)) return true;

    if (!token) return false;
    const row = await FirewallToken.findOne({ token, status: 'approved' });
    if (!row) return false;
    return true;
  }

  /** Polled by the firewall HTML page until status changes */
  async getStatus(requestId: string): Promise<{ status: string; token?: string; visitorName?: string }> {
    if (!requestId) return { status: 'unknown' };
    const row = await FirewallToken.findOne({ requestId });
    if (!row) return { status: 'unknown' };
    return {
      status: row.status,
      visitorName: row.visitorName,
      token: row.status === 'approved' ? row.token : undefined,
    };
  }

  /** Get or create a long-lived firewall token for employee Playwright sessions (local only) */
  async getOrCreateLocalToken(): Promise<string> {
    const existing = await FirewallToken.findOne({
      visitorName: 'employee-local',
      status: 'approved',
    });
    if (existing) return existing.token;

    const token = randomUUID();
    await FirewallToken.create({
      requestId: randomUUID(),
      token,
      visitorName: 'employee-local',
      visitorIp: '127.0.0.1',
      visitorUserAgent: 'playwright-mcp',
      status: 'approved',
      approvedAt: new Date(),
    });
    console.log(`${LOG_PREFIX} Created local employee token`);
    return token;
  }

  /** Generate a one-time share link token for a specific app */
  async generateShareToken(appSlug: string): Promise<string> {
    const shareToken = randomUUID();
    await FirewallToken.create({
      requestId: randomUUID(),
      token: randomUUID(),
      shareToken,
      shareApp: appSlug,
      visitorName: `share:${appSlug}`,
      visitorIp: '',
      visitorUserAgent: '',
      status: 'approved',
      approvedAt: new Date(),
    });
    console.log(`${LOG_PREFIX} Share token created for ${appSlug}`);
    return shareToken;
  }

  /** Resolve a share token — returns the firewall cookie token + app slug, or null if not found.
   *  Reusable: the share row itself carries a firewall token, which we hand out on every click. */
  async consumeShareToken(shareToken: string): Promise<{ firewallToken: string; appSlug: string } | null> {
    if (!shareToken) return null;
    const row = await FirewallToken.findOne({
      shareToken,
      status: 'approved',
    });
    if (!row || !row.token) return null;
    return { firewallToken: row.token, appSlug: row.shareApp || '' };
  }
}

export const firewallService = new FirewallService();
