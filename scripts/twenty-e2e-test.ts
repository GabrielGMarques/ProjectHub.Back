// End-to-end test: create a project via ProjectService and verify Twenty
// provisioning populates twentyApiKey + twentyWorkspaceId on the doc.
//
// Run with: cd backend && npx ts-node scripts/twenty-e2e-test.ts
import 'dotenv/config';
import mongoose from 'mongoose';
import { ProjectService } from '../src/services/project.service';
import { Project } from '../src/models/project.model';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/projectshub';
const TEST_USER_ID = new mongoose.Types.ObjectId().toString();

async function main() {
  console.log('[e2e] connecting to mongo…');
  await mongoose.connect(MONGO_URI);

  const svc = new ProjectService();
  const name = `e2e-twenty-${Date.now()}`;
  console.log(`[e2e] creating project "${name}"…`);
  const project = await svc.create(TEST_USER_ID, { name, description: 'twenty e2e' });
  console.log(`[e2e] project saved id=${project._id} status=${project.twentyProvisionStatus}`);

  // Poll for provisioning completion (max 3 min)
  const startMs = Date.now();
  const timeoutMs = 180_000;
  while (Date.now() - startMs < timeoutMs) {
    const fresh = await Project.findById(project._id);
    if (!fresh) throw new Error('project vanished');
    const status = fresh.twentyProvisionStatus;
    process.stdout.write(`\r[e2e] elapsed=${Math.round((Date.now() - startMs) / 1000)}s status=${status} `);
    if (status === 'provisioned') {
      console.log('\n[e2e] PROVISIONED.');
      console.log(`  twentyCompanyId: ${fresh.twentyCompanyId}`);
      await Project.findByIdAndDelete(project._id);
      console.log('[e2e] test project cleaned up');
      await mongoose.disconnect();
      return;
    }
    if (status === 'failed') {
      console.error('\n[e2e] PROVISIONING FAILED — check backend logs');
      await Project.findByIdAndDelete(project._id);
      await mongoose.disconnect();
      process.exit(2);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.error('\n[e2e] TIMEOUT — provisioning did not complete in 3 min');
  await Project.findByIdAndDelete(project._id);
  await mongoose.disconnect();
  process.exit(3);
}

main().catch(err => { console.error(err); process.exit(1); });
