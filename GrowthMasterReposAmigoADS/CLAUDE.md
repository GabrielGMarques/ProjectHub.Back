<!-- AUTO-GENERATED:START — managed by ProjectsHub obsidian-sync -->
<!-- Last sync: 2026-05-18T21:19:31.386Z -->

# Amigo Project `1b6334`

Paid ads and marketing automation platform for e-commerces. Automates and increase performance of ecomerce business based on specific metrics we will define and will control. It will use Shopify apis to do those improviments on their website based on suggestions given by our metrics and availations. Our key is our metrics engine that will availate the health and performance of the ecommerce listing.



## Team (8)

| Employee | ID | Role | Status | Last Activity |
|----------|----|----|--------|---------------|
| 📋 Product Manager | `10481f` | product-manager | idle | 2026-03-21 |
| 👔 Chief Technology Officer | `d1e060` | cto | idle | 2026-04-08 |
| 🔧 Full Stack Developer | `aa7c5c` | fullstack-developer | idle | 2026-04-08 |
| 🧑‍💻 Tech Lead | `aa7c64` | tech-lead | idle | 2026-03-21 |
| 🎭 UI/UX Designer | `aa7c6c` | ui-ux-designer | idle | 2026-03-20 |
| 🏗️ Infrastructure Administrator | `19eee0` | infra-administrator | idle | 2026-04-29 |
| 🧪 Quality Control Tester | `c56ae4` | qa-tester | idle | 2026-04-08 |
| 📢 Marketing Specialist | `0ed3c8` | marketing-specialist | idle | 2026-04-29 |

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
