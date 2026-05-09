<!-- AUTO-GENERATED:START — managed by ProjectsHub obsidian-sync -->
<!-- Last sync: 2026-05-05T16:07:27.329Z -->

# Dropshipping `1b6336`

Brazilian Dropshipping Ecosystem — a suite of integrated applications that: (1) Connects to local Brazilian suppliers and manages supplier relationships, (2) Publishes products across multiple platforms: MercadoLivre, Shopify (own e-commerce), and other Brazilian marketplaces, (3) Syncs inventory, pricing, and product listings across ALL connected platforms automatically, (4) Integrates with multiple supplier systems to pull catalogs, stock levels, and pricing, (5) Automates the full sale-to-del



## Team (7)

| Employee | ID | Role | Status | Last Activity |
|----------|----|----|--------|---------------|
| 🏛️ Chief Executive Officer | `977dfd` | ceo | idle | 2026-03-21 |
| 👔 Chief Technology Officer | `977e05` | cto | idle | 2026-04-08 |
| 🏗️ Infrastructure Administrator | `b02453` | infra-administrator | idle | 2026-03-20 |
| 🔧 Full Stack Developer | `a3c3c0` | fullstack-developer | idle | 2026-03-20 |
| 🔧 Full Stack Developer | `a3c3c6` | fullstack-developer | idle | 2026-03-20 |
| 🧪 Quality Control Tester | `c56adc` | qa-tester | idle | 2026-03-21 |
| 📢 Marketing Specialist | `db3d29` | marketing-specialist | idle | 2026-04-21 |

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
