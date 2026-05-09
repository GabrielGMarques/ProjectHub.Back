<!-- AUTO-GENERATED:START — managed by ProjectsHub obsidian-sync -->
<!-- Last sync: 2026-05-05T16:07:27.085Z -->

# Amazing Shirt `1b6333`

AI-generated art e-commerce on Shopify. We list AI-generated pictures/art, customers buy shirts with those designs. Orders go to partner printers (companies that print shirts for money), then delivered to customers — all automated. Modular architecture: plug any printer, manufacturer, or delivery partner per country. Operates in Brazil and Europe (Portugal focus). Country-specific supplier/manufacturer/delivery configs. Shopify storefront integration. Fully automated pipeline: customer buys → or


## Applications
- **content-dashboard** (frontend) — port 3001 — running
- **order-router** (backend) — port 4001 — running

## Team (7)

| Employee | ID | Role | Status | Last Activity |
|----------|----|----|--------|---------------|
| 🏛️ Chief Executive Officer | `e31591` | ceo | idle | 2026-04-08 |
| 📋 Product Manager | `b17347` | product-manager | idle | 2026-04-08 |
| 👔 Chief Technology Officer | `b1af7b` | cto | idle | 2026-04-08 |
| 🎭 UI/UX Designer | `1cb004` | ui-ux-designer | idle | 2026-04-08 |
| 🔧 Full Stack Developer | `401eba` | fullstack-developer | idle | 2026-04-25 |
| 🔧 Full Stack Developer | `dacee5` | fullstack-developer | idle | 2026-04-12 |
| 🧪 Quality Control Tester | `db44f5` | qa-tester | idle | 2026-04-08 |

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
