/**
 * Standalone CLI: regenerate the nginx gateway config + chooser HTML.
 *
 * Used by `npm run dev:gateway` so the gateway always boots with fresh config
 * (matching the current state of registered applications in MongoDB).
 *
 * Usage:
 *   npx ts-node src/scripts/regen-gateway.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { infrastructureService } from '../services/infrastructure.service';

async function main() {
  await connectDatabase();

  // Ensure the nginx project skeleton exists (Dockerfile, docker-compose.yml, chooser dir)
  infrastructureService.ensureNginxProject();

  // Find the first user to scope the regeneration. The gateway is global,
  // so picking any user is fine — the dev workflow assumes a single Bruce.
  const User = mongoose.connection.db!.collection('users');
  const user = await User.findOne();

  if (!user) {
    console.warn('[gateway] No users found in DB — generating empty gateway config (chooser will list only Alfred).');
    // ensureNginxProject already wrote a stub config — we're done.
    await mongoose.disconnect();
    return;
  }

  const result = await infrastructureService.regenerateNginx(user._id.toString());
  console.log(`[gateway] Regenerated config: ${result.locations} apps across ${result.companies} companies`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[gateway] Regenerate failed:', err.message);
  process.exit(1);
});
