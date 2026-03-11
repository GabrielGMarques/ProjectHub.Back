import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISkill extends Document {
  projectId: Types.ObjectId | null;
  userId: Types.ObjectId;
  name: string;
  description: string;
  icon: string;
  prompt: string;
  category: 'development' | 'marketing' | 'analysis' | 'operations' | 'custom';
  executionMode: 'ai-chat' | 'claude-code';
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const skillSchema = new Schema<ISkill>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    icon: { type: String, default: 'build' },
    prompt: { type: String, required: true },
    category: { type: String, enum: ['development', 'marketing', 'analysis', 'operations', 'custom'], default: 'custom' },
    executionMode: { type: String, enum: ['ai-chat', 'claude-code'], default: 'ai-chat' },
    isBuiltIn: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Skill = mongoose.model<ISkill>('Skill', skillSchema);

export const BUILT_IN_SKILLS = [
  {
    name: 'Competitor Quick Scan',
    description: 'Fast competitor analysis for your niche',
    icon: 'search',
    prompt: 'Analyze the top 5 competitors in my niche. For each, provide: name, website, key strengths, weaknesses, and estimated revenue. Format as a structured comparison.',
    category: 'marketing' as const,
    executionMode: 'ai-chat' as const,
  },
  {
    name: 'Growth Strategy',
    description: 'Generate actionable growth strategies based on your metrics',
    icon: 'trending_up',
    prompt: 'Based on my current MRR, client count, and niche, suggest 5 specific growth strategies. For each, include: the strategy, expected impact, effort level, timeline, and first 3 action steps.',
    category: 'marketing' as const,
    executionMode: 'ai-chat' as const,
  },
  {
    name: 'Code Review',
    description: 'Run a code review on the project',
    icon: 'code',
    prompt: 'Review the codebase for code quality issues, potential bugs, security vulnerabilities, and suggest improvements. Focus on the most critical files first.',
    category: 'development' as const,
    executionMode: 'claude-code' as const,
  },
  {
    name: 'Security Audit',
    description: 'Check for security vulnerabilities',
    icon: 'security',
    prompt: 'Perform a security audit on this project. Check for common vulnerabilities (OWASP Top 10), insecure dependencies, hardcoded secrets, and misconfigured settings. Provide actionable fixes.',
    category: 'development' as const,
    executionMode: 'claude-code' as const,
  },
  {
    name: 'Generate README',
    description: 'Create or update the project README',
    icon: 'description',
    prompt: 'Generate a comprehensive README.md for this project. Include: project overview, features, tech stack, installation steps, usage instructions, API documentation, and contribution guidelines.',
    category: 'development' as const,
    executionMode: 'claude-code' as const,
  },
  {
    name: 'Performance Analysis',
    description: 'Analyze project performance and suggest optimizations',
    icon: 'speed',
    prompt: 'Analyze this project for performance bottlenecks. Check for: slow database queries, unoptimized assets, missing caching, N+1 problems, and memory leaks. Suggest specific fixes with code examples.',
    category: 'analysis' as const,
    executionMode: 'claude-code' as const,
  },
  {
    name: 'Weekly Status Report',
    description: 'Generate a status report from project data',
    icon: 'assessment',
    prompt: 'Based on my project metrics (MRR, clients, todos, schedule), generate a concise weekly status report. Include: key metrics summary, completed tasks, upcoming priorities, risks, and recommended focus areas for next week.',
    category: 'operations' as const,
    executionMode: 'ai-chat' as const,
  },
  {
    name: 'SEO Analysis',
    description: 'Analyze and improve SEO strategy',
    icon: 'language',
    prompt: 'Analyze SEO opportunities for my project. Suggest: target keywords, content strategy, technical SEO improvements, link building tactics, and local SEO if applicable. Prioritize by potential impact.',
    category: 'marketing' as const,
    executionMode: 'ai-chat' as const,
  },
];
