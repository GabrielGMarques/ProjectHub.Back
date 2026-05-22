<!-- AUTO-GENERATED:START — managed by ProjectsHub obsidian-sync -->
<!-- Last sync: 2026-05-18T21:19:31.642Z -->

# Influencer `1b6338`

Use my tech skills and create a channel that will promote my image


## Applications
- **personal-brand** (frontend) — port 4000 — running
- **news-platform** (backend) — port 4100 — running
- **monitoring-dashboard** (frontend) — port 4200 — running
- **image-generator** (backend) — port 4300 — running
- **content-pipeline** (backend) — port 4400 — running

## Team (7)

| Employee | ID | Role | Status | Last Activity |
|----------|----|----|--------|---------------|
| 🔧 Full Stack Developer | `10339f` | fullstack-developer | idle | 2026-04-21 |
| 📢 Marketing Specialist | `1033a7` | marketing-specialist | idle | 2026-04-12 |
| 👔 Chief Technology Officer | `d4d0ee` | cto | idle | 2026-04-08 |
| 🧪 Quality Control Tester | `d4f588` | qa-tester | idle | 2026-04-08 |
| 🔧 Full Stack Developer | `d524d6` | fullstack-developer | idle | 2026-04-10 |
| 🎭 UI/UX Designer | `e2aad0` | ui-ux-designer | idle | 2026-04-08 |
| 📋 Product Manager | `21c40d` | product-manager | idle | 2026-04-08 |

## Public Gateway Rules

All apps in this workspace run behind a shared nginx gateway exposed via ngrok at:
`https://nonshattering-adelaida-ponchoed.ngrok-free.dev`

Every app MUST be reachable through that public URL — not just localhost.

**Frontends:**
- Use RELATIVE paths for all assets, API calls, and client-side routes (no hardcoded `http://localhost` or absolute URLs)
- Must work both at the root `/` (cookie-routed) and at `/<company>__<app>/` (path-routed)
- Respect the `X-Base-Path` header set by nginx for path-routed apps
- Use HTML5 history mode for SPA routing

**Backends:**
- CORS MUST allow `https://nonshattering-adelaida-ponchoed.ngrok-free.dev` (in addition to `http://localhost:4567` for dev)
- CORS MUST set `credentials: true` so cookies cross the boundary
- Trust `X-Forwarded-Proto` and `X-Forwarded-For` headers from nginx
- Cookies should use `SameSite=Lax` (or `None; Secure` for cross-site) and `Path=/`

Test EVERY app at both `http://localhost:<port>` AND `https://nonshattering-adelaida-ponchoed.ngrok-free.dev/<your-shortcut>` before marking it done.

<!-- AUTO-GENERATED:END -->
