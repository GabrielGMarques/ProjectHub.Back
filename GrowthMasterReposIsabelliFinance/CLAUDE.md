<!-- AUTO-GENERATED:START — managed by ProjectsHub obsidian-sync -->
<!-- Last sync: 2026-05-18T21:19:31.564Z -->

# Finance Automation for Isabelli `1b6337`

Plataforma automatizada de análise e reconciliação financeira para microempresas em Curitiba-PR. Integra com SAP e outros ERPs para analisar finanças, rastrear notas fiscais e sugerir correções/otimizações. Substitui consultores financeiros tradicionais automatizando: contabilidade, fluxo de caixa, análise de lucro/prejuízo, estimativa de impostos, rastreamento de notas e relatórios de saúde financeira. Fornece recomendações acionáveis pra corrigir problemas financeiros. Target: Microempresas em


## Applications
- **isabelli-finance-web** (frontend) — port 3005 — running
- **isabelli-finance-api** (backend) — port 4002 — running

## Team (6)

| Employee | ID | Role | Status | Last Activity |
|----------|----|----|--------|---------------|
| 📋 Product Manager | `89b9b7` | product-manager | idle | 2026-05-05 |
| 🏛️ Chief Executive Officer | `e5fcb3` | ceo | idle | 2026-05-12 |
| 🔧 Full Stack Developer | `db5646` | fullstack-developer | idle | 2026-05-14 |
| 👔 Chief Technology Officer | `a37101` | cto | idle | 2026-04-08 |
| 🏗️ Infrastructure Administrator | `f7a8b8` | infra-administrator | idle | 2026-05-12 |
| 📢 Marketing Specialist | `cc0b15` | marketing-specialist | idle | 2026-05-18 |

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
