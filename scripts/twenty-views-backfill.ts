// Backfill saved Twenty Views (filtered People + Opportunities) for projects
// that have a twentyCompanyId but no view IDs yet. Idempotent.
//
// Run with: cd backend && npx ts-node scripts/twenty-views-backfill.ts
import 'dotenv/config';
import mongoose from 'mongoose';
import { Project } from '../src/models/project.model';
import { twentyService } from '../src/services/twenty.service';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/projectshub');

  const projects = await Project.find({
    twentyCompanyId: { $exists: true, $ne: '' },
    $or: [
      { twentyPeopleViewId: { $in: [null, '', undefined] } },
      { twentyOpportunitiesViewId: { $in: [null, '', undefined] } },
    ],
  });
  console.log(`[backfill-views] ${projects.length} project(s) need views`);

  let ok = 0, fail = 0;
  for (const p of projects) {
    process.stdout.write(`  • "${p.name}" … `);
    try {
      const views = await twentyService.createProjectViews(p);
      await Project.findByIdAndUpdate(p._id, {
        twentyPeopleViewId: views.peopleViewId || p.twentyPeopleViewId || '',
        twentyOpportunitiesViewId: views.opportunitiesViewId || p.twentyOpportunitiesViewId || '',
      });
      console.log(`OK (people=${views.peopleViewId?.slice(0, 8) || '-'}, opps=${views.opportunitiesViewId?.slice(0, 8) || '-'})`);
      ok++;
    } catch (e: any) {
      console.log(`FAILED: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n[backfill-views] ${ok} ok, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(err => { console.error(err); process.exit(1); });
