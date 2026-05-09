import fs from 'fs';
import path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';
import { Project, IApplication } from '../models/project.model';

const NGINX_DIR = path.resolve(__dirname, '../../../ManagerMemory/nginx');
const NGINX_CONF = path.join(NGINX_DIR, 'nginx.conf');
const DOCKER_COMPOSE = path.join(NGINX_DIR, 'docker-compose.yml');
const CHOOSER_DIR = path.join(NGINX_DIR, 'chooser');
const CHOOSER_HTML = path.join(CHOOSER_DIR, 'chooser.html');
const FIREWALL_HTML = path.join(CHOOSER_DIR, 'firewall.html');
const NGINX_PORT = 9080; // local port for nginx
const NGROK_URL = 'nonshattering-adelaida-ponchoed.ngrok-free.dev';

// Always-on app: the Alfred frontend itself (so users can pick it from the chooser)
const ALFRED_APP = {
  slug: 'alfred',
  shortcut: 'alfred',
  upstream: 'host.docker.internal:4567',
  companyName: 'Alfred',
  appName: 'Alfred',
  type: 'frontend' as const,
  port: 4567,
};

interface SlugEntry {
  cookieValue: string;        // canonical cookie value (unique)
  upstream: string;           // host.docker.internal:port
  companyName: string;
  appName: string;
  appType: string;
  port: number;
}

let ngrokProcess: ChildProcess | null = null;

export class InfrastructureService {

  /** Ensure ManagerMemory/nginx/ project exists with base files */
  ensureNginxProject(): void {
    if (!fs.existsSync(NGINX_DIR)) {
      fs.mkdirSync(NGINX_DIR, { recursive: true });
    }
    if (!fs.existsSync(CHOOSER_DIR)) {
      fs.mkdirSync(CHOOSER_DIR, { recursive: true });
    }

    // Create Dockerfile if missing
    const dockerfile = path.join(NGINX_DIR, 'Dockerfile');
    if (!fs.existsSync(dockerfile)) {
      fs.writeFileSync(dockerfile, `FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
`, 'utf-8');
    }

    // Always rewrite docker-compose.yml so the chooser volume mount stays in sync
    fs.writeFileSync(DOCKER_COMPOSE, this.generateDockerCompose(), 'utf-8');

    // Generate initial nginx.conf + chooser stub if missing
    if (!fs.existsSync(NGINX_CONF)) {
      this.regenerateNginxConf([]);
    }
    if (!fs.existsSync(CHOOSER_HTML)) {
      fs.writeFileSync(CHOOSER_HTML, this.generateChooserHtml([]), 'utf-8');
    }
    if (!fs.existsSync(FIREWALL_HTML)) {
      fs.writeFileSync(FIREWALL_HTML, this.generateFirewallHtml(), 'utf-8');
    }
  }

  /** Regenerate nginx.conf from all company applications */
  async regenerateNginx(userId: string): Promise<{ locations: number; companies: number }> {
    this.ensureNginxProject();

    const projects = await Project.find({ userId, onHolding: { $ne: true } });
    const allApps: { companyName: string; app: IApplication }[] = [];

    for (const p of projects) {
      for (const app of (p.applications || [])) {
        allApps.push({ companyName: p.name, app });
      }
    }

    this.regenerateNginxConf(allApps);
    this.regenerateDockerCompose();

    return { locations: allApps.length, companies: projects.filter(p => (p.applications || []).length > 0).length };
  }

  /**
   * Build the canonical slug map: every app (including the always-on Alfred app)
   * gets a unique cookie value, plus optional collision-free shortcuts.
   */
  private buildSlugMap(apps: { companyName: string; app: IApplication }[]): {
    entries: SlugEntry[];                        // canonical, one per app
    appShortcuts: Map<string, string>;           // shortShortcut → cookieValue (unique only)
    companyShortcuts: Map<string, string>;       // companyShortcut → cookieValue (one per company)
  } {
    // Build canonical entries — start with Alfred (always available)
    const entries: SlugEntry[] = [{
      cookieValue: ALFRED_APP.slug,
      upstream: ALFRED_APP.upstream,
      companyName: ALFRED_APP.companyName,
      appName: ALFRED_APP.appName,
      appType: ALFRED_APP.type,
      port: ALFRED_APP.port,
    }];

    for (const { companyName, app } of apps) {
      const cs = this.slugify(companyName);
      const as = this.slugify(app.name);
      entries.push({
        cookieValue: `${cs}__${as}`,
        upstream: `host.docker.internal:${app.port}`,
        companyName,
        appName: app.name,
        appType: app.type,
        port: app.port,
      });
    }

    // App-level shortcuts: use the short slug if it's unique across ALL entries
    const shortCount = new Map<string, number>();
    for (const e of entries) {
      const short = this.slugify(e.appName);
      shortCount.set(short, (shortCount.get(short) || 0) + 1);
    }
    const appShortcuts = new Map<string, string>();
    for (const e of entries) {
      const short = this.slugify(e.appName);
      if ((shortCount.get(short) || 0) === 1) {
        appShortcuts.set(short, e.cookieValue);
      }
      // Also always offer the canonical (long) shortcut so it works even on collision
      appShortcuts.set(e.cookieValue, e.cookieValue);
    }

    // Company-level shortcuts: pick the first frontend/fullstack app of each company
    const companyShortcuts = new Map<string, string>();
    for (const e of entries) {
      const cs = this.slugify(e.companyName);
      if (companyShortcuts.has(cs)) continue;
      const isFrontend = e.appType === 'frontend' || e.appType === 'fullstack';
      // Look ahead in the entries to see if there's a frontend for this company we should prefer
      const betterMatch = entries.find(x =>
        this.slugify(x.companyName) === cs &&
        (x.appType === 'frontend' || x.appType === 'fullstack'),
      );
      if (betterMatch) {
        companyShortcuts.set(cs, betterMatch.cookieValue);
      } else if (!isFrontend) {
        companyShortcuts.set(cs, e.cookieValue); // fallback first
      } else {
        companyShortcuts.set(cs, e.cookieValue);
      }
    }

    return { entries, appShortcuts, companyShortcuts };
  }

  /** Generate nginx.conf with path-based routing + cookie-based root routing */
  private regenerateNginxConf(apps: { companyName: string; app: IApplication }[]): void {
    const slugMap = this.buildSlugMap(apps);

    // ── Cookie → port map ──
    // We map only to the port (not full host:port) so that proxy_pass can use a
    // hardcoded hostname (host.docker.internal) which nginx resolves at startup
    // via /etc/hosts. Using a variable for the whole upstream forces nginx to
    // require a `resolver` directive AND bypass /etc/hosts at request time.
    const cookieMapLines = slugMap.entries.map(e => {
      const port = e.upstream.split(':').pop();
      return `        "${e.cookieValue}"  "${port}";`;
    }).join('\n');

    // ── Path shortcuts: per-app and per-company ──
    // We deduplicate by the literal shortcut path so we never emit two `location =` blocks for the same URL
    const emittedShortcuts = new Set<string>();
    const shortcutBlocks: string[] = [];

    // Re-used in every protected location — gates each request behind the firewall
    const authRequest = `auth_request /__firewall_check;
            error_page 401 = @firewall_redirect;`;

    const addShortcut = (shortcut: string, cookieValue: string, comment: string) => {
      const key = `/${shortcut}`;
      if (emittedShortcuts.has(key)) return;
      emittedShortcuts.add(key);
      shortcutBlocks.push(`
        # Shortcut: ${comment}
        location = /${shortcut} {
            # If ?access= token present, redirect to backend to consume it (one-time share link)
            if ($arg_access != "") {
                return 302 /api/firewall/access?token=$arg_access;
            }
            ${authRequest}
            add_header Set-Cookie "selected_app=${cookieValue}; Path=/; Max-Age=2592000; SameSite=Lax";
            return 302 /;
        }`);
    };

    // App-level shortcuts (lowercase slugs)
    for (const [shortcut, cookieValue] of slugMap.appShortcuts.entries()) {
      addShortcut(shortcut, cookieValue, `app → ${cookieValue}`);
    }
    // Company-level shortcuts: emit BOTH the slug form (lowercase) AND the original
    // company name form (e.g. /AIInfluencer) so users can hit either
    for (const [companySlug, cookieValue] of slugMap.companyShortcuts.entries()) {
      addShortcut(companySlug, cookieValue, `company → ${cookieValue}`);
    }
    // Original-name company shortcuts (preserve casing) — find the canonical name from entries
    const seenCompanyNames = new Set<string>();
    for (const e of slugMap.entries) {
      const original = e.companyName.replace(/\s+/g, '');
      if (seenCompanyNames.has(original)) continue;
      seenCompanyNames.add(original);
      const cs = this.slugify(e.companyName);
      const cookieValue = slugMap.companyShortcuts.get(cs);
      if (cookieValue && original !== cs) {
        addShortcut(original, cookieValue, `company (original casing) → ${cookieValue}`);
      }
    }

    // ── Existing path-based routes (kept for backward compat) ──
    const pathLocations = apps.map(({ companyName, app }) => {
      const safeName = this.slugify(companyName);
      const safeApp = this.slugify(app.name);
      const basePath = app.basePath || `/${safeName}/${safeApp}`;
      const isFrontend = app.type === 'frontend' || app.type === 'fullstack';
      const baseHeader = isFrontend ? `
            proxy_set_header X-Base-Path ${basePath};` : '';
      return `
        # ${companyName} / ${app.name} (${app.type}:${app.port})
        location ${basePath}/ {
            ${authRequest}
            proxy_pass http://host.docker.internal:${app.port}/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $real_scheme;${baseHeader}
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_read_timeout 86400;
        }`;
    }).join('\n');

    const conf = `# Auto-generated by ProjectsHub Infrastructure Service
# DO NOT EDIT — regenerated on every application change
# Last generated: ${new Date().toISOString()}

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /tmp/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Access log silenced to keep the dev console clean.
    # Errors still go to stderr (visible in [gw] stream).
    access_log off;
    sendfile on;
    keepalive_timeout 65;
    client_max_body_size 50m;

    # Bigger hash buckets so long cookie values + server names fit
    map_hash_bucket_size 256;
    map_hash_max_size 4096;
    server_names_hash_bucket_size 128;

    # Handle ngrok-skip-browser-warning
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    # Real client protocol — trust X-Forwarded-Proto from the upstream proxy (ngrok)
    # so backends generate correct https:// URLs even though nginx itself sees http.
    map $http_x_forwarded_proto $real_scheme {
        default $scheme;
        ""      $scheme;
        ~.+     $http_x_forwarded_proto;
    }

    # Cookie → upstream map (for cookie-based root routing)
    map $cookie_selected_app $app_port {
        default "3005";
${cookieMapLines}
    }

    # DNS resolver — required because the catch-all uses a variable in proxy_pass.
    # Docker's embedded DNS at 127.0.0.11 forwards to the host resolver, which knows
    # about /etc/hosts entries (including host.docker.internal from extra_hosts).
    resolver 127.0.0.11 valid=30s ipv6=off;

    server {
        listen 80;
        server_name localhost ${NGROK_URL};

        # Keep redirects relative — prevents nginx from baking the inner http:// scheme
        # into Location headers when we're behind an HTTPS-terminating proxy (ngrok).
        absolute_redirect off;

        # ngrok health check (PUBLIC — no firewall)
        location = /health {
            return 200 'ProjectsHub Gateway OK';
            add_header Content-Type text/plain;
        }

        # ── FIREWALL: bypass routes (PUBLIC — never gated) ──
        # Static HTML form for visitors to request access
        location = /__firewall {
            root /usr/share/nginx/chooser;
            try_files /firewall.html =404;
        }
        # Backend API for the firewall flow (request, status, set-cookie, validate)
        location /api/firewall/ {
            proxy_pass http://host.docker.internal:3777/api/firewall/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $real_scheme;
            proxy_http_version 1.1;
        }
        # Internal-only validation endpoint used by auth_request
        location = /__firewall_check {
            internal;
            proxy_pass http://host.docker.internal:3777/api/firewall/validate;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_set_header X-Original-URI $request_uri;
            proxy_set_header Cookie $http_cookie;
        }
        # Named location used as the 401 fallback for auth_request — redirects to the form
        location @firewall_redirect {
            return 302 /__firewall;
        }

        # ── PROTECTED ROUTES (all require valid firewall_token cookie) ──

        # Alfred backend API — gated by the firewall, proxied to backend on host
        location /api/ {
            ${authRequest}
            proxy_pass http://host.docker.internal:3777/api/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $real_scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_read_timeout 86400;
        }

        # Chooser page — static HTML, mounted from ./chooser
        location = /__chooser {
            ${authRequest}
            root /usr/share/nginx/chooser;
            try_files /chooser.html =404;
        }
        location = /__clear {
            ${authRequest}
            add_header Set-Cookie "selected_app=; Path=/; Max-Age=0; SameSite=Lax";
            return 302 /__chooser;
        }
${shortcutBlocks.join('\n')}
${pathLocations}

        # Cookie-based catch-all: route /  to the app picked via cookie
        location / {
            ${authRequest}
            if ($app_port = "") {
                return 302 /__chooser;
            }
            proxy_pass http://host.docker.internal:$app_port;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $real_scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_read_timeout 86400;
        }
    }
}
`;

    fs.writeFileSync(NGINX_CONF, conf, 'utf-8');

    // Also write the chooser page so it's always in sync with registered apps
    fs.mkdirSync(CHOOSER_DIR, { recursive: true });
    fs.writeFileSync(CHOOSER_HTML, this.generateChooserHtml(apps), 'utf-8');
    fs.writeFileSync(FIREWALL_HTML, this.generateFirewallHtml(), 'utf-8');
  }

  /** Generate the firewall request page (static, no app data needed) */
  private generateFirewallHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Alfred — Access Request</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e7eb; padding: 0; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #161616; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2.5rem; max-width: 420px; width: 100%; margin: 1rem; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
    h1 { color: #d4af37; margin: 0 0 .25rem; font-size: 1.5rem; text-align: center; }
    .subtitle { color: #9ca3af; font-size: .85rem; text-align: center; margin: 0 0 2rem; }
    label { display: block; font-size: .75rem; color: #9ca3af; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .5rem; }
    input { width: 100%; padding: .8rem 1rem; background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 6px; color: #e5e7eb; font-family: inherit; font-size: 1rem; }
    input:focus { outline: none; border-color: #d4af37; }
    button { width: 100%; padding: .9rem; margin-top: 1rem; background: #d4af37; color: #0a0a0a; border: none; border-radius: 6px; font-family: inherit; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #e5c451; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .state { text-align: center; padding: 1rem 0; }
    .spinner { display: inline-block; width: 32px; height: 32px; border: 3px solid #2a2a2a; border-top-color: #d4af37; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .state h2 { color: #d4af37; font-size: 1.1rem; margin: 1rem 0 .5rem; }
    .state p { color: #9ca3af; font-size: .85rem; margin: 0; }
    .rejected h2 { color: #ef4444; }
    .approved h2 { color: #10b981; }
    .footer { text-align: center; margin-top: 1.5rem; font-size: .7rem; color: #6b7280; }
    .footer code { background: #0a0a0a; padding: 1px 5px; border-radius: 3px; color: #d4af37; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Alfred Gateway</h1>
    <p class="subtitle">Request access to continue</p>

    <form id="form">
      <label for="name">Your name</label>
      <input id="name" name="name" required maxlength="80" autofocus placeholder="Bruce Wayne" />
      <button type="submit" id="submitBtn">Request access</button>
    </form>

    <div id="waiting" class="state" hidden>
      <div class="spinner"></div>
      <h2>Waiting for approval...</h2>
      <p>An access request was sent. Bruce will receive a notification on Telegram and approve or decline.</p>
    </div>

    <div id="approved" class="state approved" hidden>
      <h2>✅ Approved</h2>
      <p>Redirecting...</p>
    </div>

    <div id="rejected" class="state rejected" hidden>
      <h2>❌ Access denied</h2>
      <p>Your request was declined. <a href="/__firewall" style="color:#d4af37;">Try again</a>.</p>
    </div>

    <div class="footer">Powered by <code>Alfred</code></div>
  </div>

  <script>
    const states = ['form', 'waiting', 'approved', 'rejected'];
    function show(id) { states.forEach(s => document.getElementById(s).hidden = s !== id); }

    let pollTimer = null;

    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const name = document.getElementById('name').value.trim();
      if (!name) return;
      document.getElementById('submitBtn').disabled = true;

      try {
        const r = await fetch('/api/firewall/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const data = await r.json();
        if (!data.requestId) throw new Error(data.error || 'Failed');
        if (data.autoApproved && data.token) {
          await setCookie(data.token);
          return;
        }
        show('waiting');
        pollTimer = setInterval(() => poll(data.requestId), 3000);
      } catch (err) {
        alert('Request failed: ' + err.message);
        document.getElementById('submitBtn').disabled = false;
      }
    };

    async function setCookie(token) {
      await fetch('/api/firewall/set-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });
      show('approved');
      setTimeout(() => { window.location.href = '/'; }, 600);
    }

    async function poll(requestId) {
      try {
        const r = await fetch('/api/firewall/status?requestId=' + encodeURIComponent(requestId));
        const data = await r.json();
        if (data.status === 'approved' && data.token) {
          clearInterval(pollTimer);
          await setCookie(data.token);
        } else if (data.status === 'rejected') {
          clearInterval(pollTimer);
          show('rejected');
        }
      } catch { /* keep polling */ }
    }
  </script>
</body>
</html>
`;
  }

  /** Generate the chooser HTML page (static, regenerated on every nginx config change) */
  private generateChooserHtml(apps: { companyName: string; app: IApplication }[]): string {
    const slugMap = this.buildSlugMap(apps);

    // Group entries by company for display
    const byCompany = new Map<string, SlugEntry[]>();
    for (const e of slugMap.entries) {
      if (!byCompany.has(e.companyName)) byCompany.set(e.companyName, []);
      byCompany.get(e.companyName)!.push(e);
    }

    const companyBlocks = Array.from(byCompany.entries()).map(([companyName, list]) => {
      const cards = list.map(e => `
          <div class="app-card-wrap">
            <a class="app-card" href="/${e.cookieValue}" data-cookie="${this.escHtml(e.cookieValue)}">
              <div class="app-name">${this.escHtml(e.appName)}</div>
              <div class="app-meta">${this.escHtml(e.appType)} · port ${e.port}</div>
            </a>
            <button class="share-btn" onclick="copyLink(event, '${this.escHtml(e.cookieValue)}')" title="Copy share link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </button>
          </div>`).join('');
      return `
      <div class="company">
        <h2>${this.escHtml(companyName)}</h2>
        <div class="apps">${cards}
        </div>
      </div>`;
    }).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Alfred — Choose an application</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e7eb; padding: 2rem; max-width: 1280px; margin: 0 auto; }
    h1 { color: #d4af37; margin: 0 0 .25rem; font-size: 1.5rem; }
    .top-bar { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:2rem; gap: 1rem; flex-wrap: wrap; }
    .top-bar p { margin: 0; color: #9ca3af; font-size: .85rem; }
    .clear { color:#d4af37; text-decoration: none; font-size:.8rem; border:1px solid #d4af37; padding: .35rem .8rem; border-radius:4px; white-space: nowrap; }
    .clear:hover { background:#d4af37; color:#0a0a0a; }
    .company { margin-bottom: 2rem; }
    .company h2 { color: #d4af37; font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid #2a2a2a; padding-bottom: .5rem; margin-bottom: 1rem; }
    .apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: .75rem; }
    .app-card-wrap { position: relative; }
    .app-card { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; text-decoration: none; color: inherit; transition: all .15s; display:block; }
    .app-card:hover { border-color: #d4af37; transform: translateY(-2px); background: #1c1c1c; }
    .app-card.selected { border-color: #d4af37; background: #25210f; }
    .app-name { font-weight: 600; font-size: .95rem; color: #f3f4f6; }
    .app-meta { font-size: .72rem; color: #9ca3af; margin-top: .25rem; font-family: ui-monospace, monospace; }
    .share-btn { position: absolute; top: 8px; right: 8px; background: none; border: 1px solid #3a3a3a; border-radius: 5px; color: #9ca3af; cursor: pointer; padding: 4px 6px; line-height: 1; transition: all .15s; }
    .share-btn:hover { border-color: #d4af37; color: #d4af37; }
    .share-btn.copied { border-color: #10b981; color: #10b981; }
    .toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); background: #10b981; color: #0a0a0a; padding: .5rem 1.25rem; border-radius: 6px; font-size: .85rem; font-weight: 600; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 99; }
    .toast.show { opacity: 1; }
    footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #2a2a2a; color: #6b7280; font-size: .72rem; }
    code { background: #1a1a1a; padding: 1px 5px; border-radius: 3px; color: #d4af37; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div>
      <h1>Choose an application</h1>
      <p>Pick an app to use. Your choice is saved as a cookie and the gateway will route the root URL to it until you change it.</p>
    </div>
    <a href="/__clear" class="clear">Clear selection</a>
  </div>
${companyBlocks}
  <footer>
    Tip: deep-link to an app via its slug, e.g. <code>/alfred</code>, <code>/&lt;company&gt;</code>, or <code>/&lt;company&gt;__&lt;app&gt;</code>.
    Hitting one of these paths sets the cookie automatically and redirects to <code>/</code>.
  </footer>
  <div class="toast" id="toast">Link copied!</div>
  <script>
    // Highlight the currently-selected app card based on the cookie
    var m = document.cookie.match(/(?:^|; )selected_app=([^;]+)/);
    if (m) {
      var card = document.querySelector('.app-card[data-cookie="' + m[1] + '"]');
      if (card) card.classList.add('selected');
    }

    function copyLink(e, slug) {
      e.preventDefault();
      e.stopPropagation();
      var btn = e.currentTarget;
      btn.disabled = true;
      fetch('/api/firewall/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appSlug: slug }),
        credentials: 'include',
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var url = data.url || (location.origin + '/' + slug);
        navigator.clipboard.writeText(url).then(function() {
          btn.classList.add('copied');
          setTimeout(function() { btn.classList.remove('copied'); btn.disabled = false; }, 1500);
          var toast = document.getElementById('toast');
          toast.textContent = 'Copied share link!';
          toast.classList.add('show');
          setTimeout(function() { toast.classList.remove('show'); }, 2500);
        });
      })
      .catch(function() { btn.disabled = false; alert('Failed to generate share link'); });
    }
  </script>
</body>
</html>
`;
  }

  private escHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private generateDockerCompose(): string {
    return `# Auto-generated by ProjectsHub Infrastructure Service
version: "3.8"
services:
  gateway:
    build: .
    container_name: projectshub-gateway
    ports:
      - "${NGINX_PORT}:80"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./chooser:/usr/share/nginx/chooser:ro
`;
  }

  private regenerateDockerCompose(): void {
    fs.writeFileSync(DOCKER_COMPOSE, this.generateDockerCompose(), 'utf-8');
  }

  /** Start the nginx gateway container */
  async startGateway(): Promise<string> {
    this.ensureNginxProject();
    return new Promise((resolve, reject) => {
      exec('docker-compose up -d --build', { cwd: NGINX_DIR }, (err, stdout, stderr) => {
        if (err) reject(new Error(`Gateway start failed: ${stderr || err.message}`));
        else resolve(`Gateway started on port ${NGINX_PORT}\n${stdout}`);
      });
    });
  }

  /** Stop the nginx gateway */
  async stopGateway(): Promise<string> {
    return new Promise((resolve, reject) => {
      exec('docker-compose down', { cwd: NGINX_DIR }, (err, stdout, stderr) => {
        if (err) reject(new Error(`Gateway stop failed: ${stderr || err.message}`));
        else resolve(`Gateway stopped\n${stdout}`);
      });
    });
  }

  /** Restart gateway (rebuild config + restart container) */
  async restartGateway(userId: string): Promise<string> {
    await this.regenerateNginx(userId);
    return new Promise((resolve, reject) => {
      exec('docker-compose up -d --build', { cwd: NGINX_DIR }, (err, stdout, stderr) => {
        if (err) reject(new Error(`Gateway restart failed: ${stderr || err.message}`));
        else resolve(`Gateway restarted on port ${NGINX_PORT}\n${stdout}`);
      });
    });
  }

  /** Reload nginx config without full restart */
  async reloadGateway(): Promise<string> {
    return new Promise((resolve, reject) => {
      exec('docker exec projectshub-gateway nginx -s reload', (err, stdout, stderr) => {
        if (err) reject(new Error(`Reload failed: ${stderr || err.message}`));
        else resolve('Nginx config reloaded');
      });
    });
  }

  /** Start ngrok tunnel pointing at the nginx gateway */
  async startNgrok(): Promise<string> {
    if (ngrokProcess) {
      return 'Ngrok is already running';
    }

    return new Promise((resolve) => {
      ngrokProcess = spawn('ngrok', ['http', String(NGINX_PORT), '--domain', NGROK_URL], {
        stdio: 'pipe',
        detached: false,
      });

      ngrokProcess.on('error', (err) => {
        ngrokProcess = null;
        resolve(`Ngrok failed to start: ${err.message}`);
      });

      ngrokProcess.on('exit', () => {
        ngrokProcess = null;
      });

      // Give it a moment to start
      setTimeout(() => {
        if (ngrokProcess) {
          resolve(`Ngrok started: https://${NGROK_URL} → localhost:${NGINX_PORT}`);
        } else {
          resolve('Ngrok process exited unexpectedly');
        }
      }, 2000);
    });
  }

  /** Stop ngrok tunnel */
  stopNgrok(): string {
    if (ngrokProcess) {
      ngrokProcess.kill();
      ngrokProcess = null;
      return 'Ngrok stopped';
    }
    return 'Ngrok was not running';
  }

  isNgrokRunning(): boolean {
    return ngrokProcess !== null;
  }

  getGatewayPort(): number {
    return NGINX_PORT;
  }

  getNgrokUrl(): string {
    return `https://${NGROK_URL}`;
  }

  /** Get the full external URL for an application */
  getAppUrl(companyName: string, appName: string, basePath?: string): string {
    const bp = basePath || `/${this.slugify(companyName)}/${this.slugify(appName)}`;
    return `https://${NGROK_URL}${bp}/`;
  }

  /** Add an application to a company */
  async addApplication(userId: string, projectId: string, app: Partial<IApplication>): Promise<IApplication> {
    const project = await Project.findOne({ _id: projectId, userId });
    if (!project) throw new Error('Company not found');

    const safeName = this.slugify(project.name);
    const safeApp = this.slugify(app.name || 'app');

    const newApp: IApplication = {
      name: app.name || 'app',
      port: app.port || 3000,
      type: app.type || 'fullstack',
      dockerService: app.dockerService || safeApp,
      command: app.command || `docker-compose up -d ${safeApp}`,
      status: 'stopped',
      tested: false,
      basePath: app.basePath || `/${safeName}/${safeApp}`,
      description: app.description || '',
      purpose: app.purpose || '',
      testInstructions: app.testInstructions || '',
      screenshots: [],
    };

    project.applications.push(newApp);
    await project.save();

    // Regenerate nginx config
    await this.regenerateNginx(userId);

    return newApp;
  }

  /** Remove an application from a company */
  async removeApplication(userId: string, projectId: string, appName: string): Promise<void> {
    const project = await Project.findOne({ _id: projectId, userId });
    if (!project) throw new Error('Company not found');

    project.applications = project.applications.filter(a => a.name !== appName);
    await project.save();

    await this.regenerateNginx(userId);
  }

  /** Update an application */
  async updateApplication(userId: string, projectId: string, appName: string, updates: Partial<IApplication>): Promise<IApplication | null> {
    const project = await Project.findOne({ _id: projectId, userId });
    if (!project) throw new Error('Company not found');

    const app = project.applications.find(a => a.name === appName);
    if (!app) throw new Error(`Application "${appName}" not found`);

    if (updates.name !== undefined) app.name = updates.name;
    if (updates.port !== undefined) app.port = updates.port;
    if (updates.type !== undefined) app.type = updates.type;
    if (updates.dockerService !== undefined) app.dockerService = updates.dockerService;
    if (updates.command !== undefined) app.command = updates.command;
    if (updates.status !== undefined) app.status = updates.status;
    if (updates.tested !== undefined) app.tested = updates.tested;
    if (updates.basePath !== undefined) app.basePath = updates.basePath;
    if (updates.description !== undefined) app.description = updates.description;
    if (updates.purpose !== undefined) app.purpose = updates.purpose;
    if (updates.testInstructions !== undefined) app.testInstructions = updates.testInstructions;

    await project.save();
    await this.regenerateNginx(userId);

    return app;
  }

  /** Get all applications across all companies */
  async getAllApplications(userId: string): Promise<{ companyName: string; companyId: string; app: IApplication }[]> {
    const projects = await Project.find({ userId });
    const result: { companyName: string; companyId: string; app: IApplication }[] = [];

    for (const p of projects) {
      for (const app of (p.applications || [])) {
        result.push({ companyName: p.name, companyId: p._id.toString(), app });
      }
    }

    return result;
  }

  /** Collect screenshots left by QA testers in .agents/screenshots/<app-name>/ and save to DB */
  async collectScreenshots(userId: string, projectId: string): Promise<number> {
    const project = await Project.findOne({ _id: projectId, userId });
    if (!project) return 0;

    const allFolders = [...(project.folders || [])];
    if (project.localPath && !allFolders.includes(project.localPath)) allFolders.unshift(project.localPath);
    const cwd = allFolders[0];
    if (!cwd) return 0;

    const screenshotsBase = path.join(cwd, '.agents', 'screenshots');
    if (!fs.existsSync(screenshotsBase)) return 0;

    const SCREENSHOTS_STORE = path.resolve(__dirname, '../../../ManagerMemory/screenshots');
    let collected = 0;

    for (const app of project.applications) {
      const appDir = path.join(screenshotsBase, app.name);
      if (!fs.existsSync(appDir)) continue;

      const files = fs.readdirSync(appDir).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
      for (const file of files) {
        // Skip if already collected
        if (app.screenshots.some(s => s.originalName === file)) continue;

        const src = path.join(appDir, file);
        const destDir = path.join(SCREENSHOTS_STORE, projectId, app.name);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const destName = `${Date.now()}-${file}`;
        fs.copyFileSync(src, path.join(destDir, destName));

        app.screenshots.push({
          filename: destName,
          originalName: file,
          caption: file.replace(/\.\w+$/, '').replace(/[-_]/g, ' '),
          takenBy: 'qa-tester',
          takenAt: new Date(),
        });
        collected++;
      }
    }

    if (collected > 0) await project.save();
    return collected;
  }

  private slugify(str: string): string {
    return str.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

export const infrastructureService = new InfrastructureService();
