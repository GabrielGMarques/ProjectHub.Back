import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { obsidianSyncService } from '../services/obsidian-sync.service';
import { config } from '../config';

async function main() {
  console.log('Vault path:', config.obsidianVaultPath);
  if (!config.obsidianVaultPath) {
    console.error('ERROR: OBSIDIAN_VAULT_PATH not set');
    process.exit(1);
  }

  await connectDatabase();

  // Find first user
  const User = mongoose.connection.db!.collection('users');
  const user = await User.findOne();
  if (!user) { console.log('No users found'); process.exit(1); }
  console.log('Using user:', user._id.toString());

  try {
    const result = await obsidianSyncService.sync(user._id.toString(), { full: true });
    console.log('\nSync result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('\nSync FAILED:', err.message);
    console.error(err.stack);
  }

  await mongoose.disconnect();
}

main();
