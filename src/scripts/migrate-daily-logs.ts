/**
 * Migration Script: Backfill Alfred's Long-Term Memory
 *
 * Reads existing daily log files from ManagerMemory/days/*.md,
 * summarizes each via Claude, embeds them, and stores as MemoryEntry documents.
 *
 * Usage:
 *   npx ts-node src/scripts/migrate-daily-logs.ts
 *
 * Idempotent — skips dates that already have a daily_summary.
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { User } from '../models/user.model';
import { memoryService } from '../services/memory.service';
import { connectDatabase } from '../config/database';

const DAYS_DIR = path.resolve(__dirname, '../../../ManagerMemory/days');

async function migrate() {
  console.log('🧠 Alfred Memory Migration — backfilling daily logs\n');

  // Connect to DB
  await connectDatabase();

  // Find the user (Alfred's owner)
  const user = await User.findOne().sort({ createdAt: 1 });
  if (!user) {
    console.log('❌ No user found in database. Start the app first.');
    process.exit(1);
  }
  const userId = user._id.toString();
  console.log(`👤 User: ${user.username} (${userId})\n`);

  // Scan for daily log files
  if (!fs.existsSync(DAYS_DIR)) {
    console.log('❌ No ManagerMemory/days/ directory found.');
    process.exit(1);
  }

  const files = fs.readdirSync(DAYS_DIR)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
    .sort();

  console.log(`📁 Found ${files.length} daily log file(s)\n`);

  let created = 0;
  let skipped = 0;

  for (const file of files) {
    const dateStr = file.replace('.md', '');
    const date = new Date(dateStr + 'T12:00:00Z');
    const logPath = path.join(DAYS_DIR, file);
    const content = fs.readFileSync(logPath, 'utf-8');

    if (content.length < 100) {
      console.log(`  ⏭️  ${dateStr} — too short (${content.length} chars), skipping`);
      skipped++;
      continue;
    }

    console.log(`  📝 ${dateStr} — ${content.length} chars`);

    try {
      const mem = await memoryService.createDailySummary(userId, content, date);
      if (mem) {
        console.log(`  ✅ ${dateStr} — summary created & embedded`);
        created++;
      } else {
        console.log(`  ⏭️  ${dateStr} — already exists, skipped`);
        skipped++;
      }
    } catch (err: any) {
      console.log(`  ❌ ${dateStr} — failed: ${err.message}`);
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n✅ Migration complete: ${created} created, ${skipped} skipped`);

  // Show memory stats
  const stats = await memoryService.getStats(userId);
  console.log(`\n📊 Memory Stats:`);
  console.log(`   Total: ${stats.total}`);
  console.log(`   By source:`, stats.bySource);
  console.log(`   By granularity:`, stats.byGranularity);

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
