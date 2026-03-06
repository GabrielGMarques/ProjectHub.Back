import mongoose from 'mongoose';
import { config } from './config';
import { Project } from './models/project.model';
import { User } from './models/user.model';

const seedProjects = [
  {
    name: 'VM Eletrica Platform',
    description: 'Electrical services management platform for VM Eletrica. Handles scheduling, client management, invoicing, and field operations tracking.',
    backgroundImage: '',
    githubRepos: [],
    mrr: 0,
    clientCount: 1,
    impact: 'high' as const,
    niche: 'Electrical Services',
    timeConsumption: 15,
  },
  {
    name: 'MirrorAPP',
    description: 'Smart mirror application with customizable widgets, weather, calendar, news feeds, and personal dashboard display.',
    backgroundImage: '',
    githubRepos: [],
    mrr: 0,
    clientCount: 0,
    impact: 'medium' as const,
    niche: 'IoT / Smart Home',
    timeConsumption: 8,
  },
  {
    name: 'ADS Automation with Emanuel',
    description: 'Advertising automation platform built in collaboration with Emanuel. Automates ad campaign creation, optimization, and reporting across multiple platforms.',
    backgroundImage: '',
    githubRepos: [],
    mrr: 0,
    clientCount: 0,
    impact: 'high' as const,
    niche: 'Digital Marketing / Advertising',
    timeConsumption: 12,
  },
  {
    name: 'ALEX APP',
    description: 'Personal assistant application with AI-powered features for task management, scheduling, and productivity optimization.',
    backgroundImage: '',
    githubRepos: [],
    mrr: 0,
    clientCount: 0,
    impact: 'medium' as const,
    niche: 'Productivity / AI',
    timeConsumption: 10,
  },
  {
    name: 'Micro Company AI Tech Consultancy',
    description: 'AI technology consultancy micro-company. Provides AI integration services, technical consulting, and custom AI solution development for businesses.',
    backgroundImage: '',
    githubRepos: [],
    mrr: 0,
    clientCount: 0,
    impact: 'high' as const,
    niche: 'AI Consultancy',
    timeConsumption: 20,
  },
];

async function seed(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');

    // Find or create a default seed user
    let user = await User.findOne({ githubId: 'seed-user' });
    if (!user) {
      user = await User.create({
        githubId: 'seed-user',
        username: 'projectshub-admin',
        displayName: 'ProjectsHub Admin',
        avatarUrl: '',
        accessToken: 'seed-token-not-for-github-api',
      });
      console.log('Created seed user: projectshub-admin');
    }

    // Check existing projects for this user
    const existing = await Project.countDocuments({ userId: user._id });
    if (existing > 0) {
      console.log(`Found ${existing} existing projects. Skipping seed to avoid duplicates.`);
      console.log('To re-seed, drop the projects collection first:');
      console.log('  db.projects.deleteMany({ userId: ObjectId("' + user._id + '") })');
    } else {
      const projects = seedProjects.map((p) => ({ ...p, userId: user!._id }));
      await Project.insertMany(projects);
      console.log(`Seeded ${projects.length} projects:`);
      seedProjects.forEach((p) => console.log(`  - ${p.name}`));
    }

    await mongoose.disconnect();
    console.log('Done.');
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

seed();
