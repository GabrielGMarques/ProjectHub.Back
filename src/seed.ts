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
    todos: [
      { text: 'Build client scheduling module', done: false },
      { text: 'Add invoice generation and PDF export', done: false },
      { text: 'Implement field technician tracking', done: false },
      { text: 'Set up client portal for service requests', done: true },
      { text: 'Design database schema', done: true },
    ],
    monetizationPlan: 'SaaS subscription model for electrical service companies. Free tier for 1 technician, $49/mo for up to 5 technicians, $149/mo for unlimited. Additional revenue from invoice processing fees (1.5% per transaction).',
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
    todos: [
      { text: 'Build widget framework and plugin system', done: false },
      { text: 'Integrate weather and calendar APIs', done: false },
      { text: 'Create mobile companion app for configuration', done: false },
      { text: 'Research Raspberry Pi display compatibility', done: true },
    ],
    monetizationPlan: 'Hardware + software bundle. Sell pre-configured smart mirror kits ($299-$599). Premium widgets marketplace with 30% commission. Monthly subscription ($4.99/mo) for cloud sync and premium features.',
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
    todos: [
      { text: 'Build multi-platform ad campaign creator', done: false },
      { text: 'Implement A/B testing automation', done: false },
      { text: 'Create reporting dashboard with ROI metrics', done: false },
      { text: 'Integrate with Meta Ads and Google Ads APIs', done: false },
      { text: 'Define MVP scope with Emanuel', done: true },
    ],
    monetizationPlan: 'Tiered SaaS pricing based on ad spend managed. Starter: $99/mo (up to $5K ad spend), Growth: $299/mo (up to $50K), Enterprise: $799/mo (unlimited). Performance bonus model: 2% of ad spend savings from AI optimization.',
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
    todos: [
      { text: 'Design conversational AI interface', done: false },
      { text: 'Build task management with smart prioritization', done: false },
      { text: 'Integrate calendar and email sync', done: false },
      { text: 'Add voice command support', done: false },
      { text: 'Create project roadmap', done: true },
    ],
    monetizationPlan: 'Freemium mobile app. Free tier: basic task management. Pro: $9.99/mo for AI features, unlimited integrations, and voice commands. Team plan: $6.99/user/mo. Target: productivity enthusiasts and small teams.',
  },
  {
    name: 'Work For Siemens',
    description: 'Contract work for Siemens. Engineering and technology solutions delivery, project management, and technical consulting.',
    backgroundImage: '',
    githubRepos: [],
    mrr: 4000,
    clientCount: 1,
    impact: 'high' as const,
    niche: 'Enterprise / Engineering',
    timeConsumption: 20,
    todos: [
      { text: 'Complete current sprint deliverables', done: false },
      { text: 'Prepare technical documentation', done: false },
      { text: 'Schedule quarterly review meeting', done: false },
      { text: 'Onboarding and NDA signing', done: true },
      { text: 'Set up development environment', done: true },
    ],
    monetizationPlan: 'Hourly/monthly contract billing. Current rate: $4,000/mo. Goal: negotiate rate increase to $5,000/mo after Q2 review. Potential to expand scope into AI consulting services for additional $2,000-3,000/mo.',
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
    todos: [
      { text: 'Register company and legal structure', done: false },
      { text: 'Build portfolio website with case studies', done: false },
      { text: 'Create service packages and pricing', done: false },
      { text: 'Reach out to 10 potential clients', done: false },
      { text: 'Define service offerings (AI audit, integration, custom dev)', done: true },
    ],
    monetizationPlan: 'Service-based revenue. AI Audit: $2,500 one-time. Integration packages: $5K-$25K per project. Monthly retainer for ongoing AI support: $2,000-$5,000/mo. Target 3 retainer clients within 6 months for $6K-$15K MRR.',
  },
];

async function seed(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');

    // Use the first real GitHub user (log in via GitHub first), or fall back to seed user
    let user = await User.findOne({ githubId: { $ne: 'seed-user' } }).sort({ createdAt: -1 });
    if (user) {
      console.log(`Found GitHub user: ${user.username} (${user.githubId})`);
    } else {
      user = await User.findOne({ githubId: 'seed-user' });
      if (!user) {
        user = await User.create({
          githubId: 'seed-user',
          username: 'projectshub-admin',
          displayName: 'ProjectsHub Admin',
          avatarUrl: '',
          accessToken: 'seed-token-not-for-github-api',
        });
      }
      console.log('No GitHub user found. Using seed user. Log in with GitHub first for best results.');
    }

    // Remove old seeded projects and re-seed
    const existing = await Project.countDocuments({ userId: user._id });
    if (existing > 0) {
      await Project.deleteMany({ userId: user._id });
      console.log(`Cleared ${existing} existing projects for user ${user.username}.`);
    }

    const projects = seedProjects.map((p) => ({ ...p, userId: user!._id }));
    await Project.insertMany(projects);
    console.log(`Seeded ${projects.length} projects for ${user.username}:`);
    seedProjects.forEach((p) => console.log(`  - ${p.name} (${p.todos.length} todos)`));

    await mongoose.disconnect();
    console.log('Done.');
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

seed();
