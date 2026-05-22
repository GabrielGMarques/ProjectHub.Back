// Backfill Twenty Company records for projects that pre-date the Twenty integration.
// Idempotent — projects that already have twentyCompanyId are skipped.
//
// Run with: cd backend && npx ts-node scripts/twenty-backfill.ts
import 'dotenv/config';
import mongoose from 'mongoose';
import { Project } from '../src/models/project.model';
import { twentyService } from '../src/services/twenty.service';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/projectshub';

async function main() {
  console.log('[backfill] connecting to mongo…');
  await mongoose.connect(MONGO_URI);

  const projects = await Project.find({
    $or: [
      { twentyCompanyId: { $exists: false } },
      { twentyCompanyId: '' },
      { twentyCompanyId: null },
    ],
  });
  console.log(`[backfill] ${projects.length} project(s) need provisioning`);

  let ok = 0, fail = 0, skip = 0;
  for (const p of projects) {
    if (p.twentyCompanyId) { skip++; continue; }
    process.stdout.write(`  • "${p.name}" … `);
    const result = await twentyService.provisionTwentyCompany(p);
    if (result) {
      console.log(`OK (Company ${result.companyId.slice(0, 8)}…)`);
      ok++;
    } else {
      console.log('FAILED');
      fail++;
    }
  }

  console.log(`\n[backfill] done: ${ok} ok, ${fail} failed, ${skip} skipped`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
