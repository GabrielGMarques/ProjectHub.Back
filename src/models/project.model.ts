import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ITodo {
  text: string;
  done: boolean;
  children?: ITodo[];
}

export interface IWeeklySchedule {
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

export interface IDocument {
  _id?: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
}

export interface ICompetitor {
  name: string;
  url: string;
  strengths: string[];
  weaknesses: string[];
  estimatedMrr: number;
  notes: string;
}

export interface IMarketingChannel {
  name: string;
  strategy: string;
  budget: string;
  expectedRoi: string;
  priority: 'low' | 'medium' | 'high';
  status: 'planned' | 'in-progress' | 'completed';
}

export interface IMarketingActionItem {
  task: string;
  channel: string;
  deadline: string;
  done: boolean;
}

export interface IMarketingResearch {
  competitors: ICompetitor[];
  marketSize: { tam: string; sam: string; som: string; sources: string[]; analyzedAt?: Date };
  trends: { title: string; description: string; relevance: 'low' | 'medium' | 'high'; source: string }[];
  benchmarks: { raw: string; analyzedAt?: Date };
  marketingPlan: {
    summary: string;
    channels: IMarketingChannel[];
    actionItems: IMarketingActionItem[];
    raw: string;
    generatedAt?: Date;
  };
  lastResearchAt?: Date;
}

export interface IAgentStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface IAgentEvent {
  type: 'start' | 'text' | 'tool_use' | 'tool_result' | 'error' | 'done';
  content?: string;
  tool?: string;
  sessionId: string;
  timestamp: Date;
}

export interface IAgentSession {
  sessionId: string;
  sdkSessionId?: string;
  type: 'marketing-research' | 'claude-code' | 'skill';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  prompt?: string;
  events?: IAgentEvent[];
  steps: IAgentStep[];
  createdAt: Date;
  completedAt?: Date;
}

export interface ICoachAction {
  type: 'add_todos' | 'update_presentation' | 'update_field';
  items?: string[];
  content?: string;
  field?: string;
  value?: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ICoachMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: ICoachAction[];
  timestamp: Date;
}

export interface IAppScreenshot {
  filename: string;
  originalName: string;
  caption: string;
  takenBy: string;
  takenAt: Date;
}

export interface IApplication {
  name: string;
  port: number;
  type: 'frontend' | 'backend' | 'fullstack' | 'service' | 'database';
  dockerService: string;
  command: string;
  status: 'running' | 'stopped' | 'building' | 'error';
  tested: boolean;
  basePath: string;
  description: string;
  purpose: string;
  testInstructions: string;
  screenshots: IAppScreenshot[];
}

export interface IStrategicCycle {
  status: 'idle' | 'pending_directions' | 'active' | 'dev' | 'qa' | 'done';
  advice: string;
  advisorRole: string;
  advisorName: string;
  startedAt?: Date;
  completedAt?: Date;
  devTasksTotal: number;
  devTasksDone: number;
  qaTasksTotal: number;
  qaTasksDone: number;
}

export interface IProject extends Document {
  userId: Types.ObjectId;
  name: string;
  description: string;
  backgroundImage: string;
  githubRepos: string[];
  /** @deprecated Use folders[0] instead */
  localPath: string;
  folders: string[];
  mrr: number;
  clientCount: number;
  impact: 'low' | 'medium' | 'high';
  niche: string;
  timeConsumption: number;
  timeSpent: number;
  timeSpentPerDay: IWeeklySchedule;
  todos: ITodo[];
  presentation: string;
  monetizationPlan: string;
  schedule: IWeeklySchedule;
  documents: IDocument[];
  applications: IApplication[];
  marketingResearch: IMarketingResearch;
  agentSessions: IAgentSession[];
  coachMessages: ICoachMessage[];
  onHolding: boolean;
  strategicDirection: string;
  strategicCycle: IStrategicCycle;
  sortOrder: number;
  burndownSortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const todoSchema: Schema = new Schema({
  text: { type: String, required: true },
  done: { type: Boolean, default: false },
}, { _id: false });
todoSchema.add({ children: [todoSchema] });

const projectSchema = new Schema<IProject>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    backgroundImage: { type: String, default: '' },
    githubRepos: [{ type: String }],
    localPath: { type: String, default: '' },
    folders: [{ type: String }],
    mrr: { type: Number, default: 0, min: 0 },
    clientCount: { type: Number, default: 0, min: 0 },
    impact: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    niche: { type: String, default: '', trim: true },
    onHolding: { type: Boolean, default: false },
    strategicDirection: { type: String, default: '' },
    strategicCycle: {
      status: { type: String, enum: ['idle', 'pending_directions', 'active', 'dev', 'qa', 'done'], default: 'idle' },
      advice: { type: String, default: '' },
      advisorRole: { type: String, default: '' },
      advisorName: { type: String, default: '' },
      startedAt: { type: Date },
      completedAt: { type: Date },
      devTasksTotal: { type: Number, default: 0 },
      devTasksDone: { type: Number, default: 0 },
      qaTasksTotal: { type: Number, default: 0 },
      qaTasksDone: { type: Number, default: 0 },
    },
    timeConsumption: { type: Number, default: 0, min: 0 },
    timeSpent: { type: Number, default: 0, min: 0 },
    timeSpentPerDay: {
      monday: { type: Number, default: 0, min: 0 },
      tuesday: { type: Number, default: 0, min: 0 },
      wednesday: { type: Number, default: 0, min: 0 },
      thursday: { type: Number, default: 0, min: 0 },
      friday: { type: Number, default: 0, min: 0 },
      saturday: { type: Number, default: 0, min: 0 },
      sunday: { type: Number, default: 0, min: 0 },
    },
    todos: [todoSchema],
    presentation: { type: String, default: '' },
    monetizationPlan: { type: String, default: '', trim: true },
    schedule: {
      monday: { type: Number, default: 0, min: 0 },
      tuesday: { type: Number, default: 0, min: 0 },
      wednesday: { type: Number, default: 0, min: 0 },
      thursday: { type: Number, default: 0, min: 0 },
      friday: { type: Number, default: 0, min: 0 },
      saturday: { type: Number, default: 0, min: 0 },
      sunday: { type: Number, default: 0, min: 0 },
    },
    documents: [{
      filename: { type: String, required: true },
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      size: { type: Number, required: true },
      uploadedAt: { type: Date, default: Date.now },
    }],
    marketingResearch: {
      competitors: [{
        name: String, url: String, strengths: [String], weaknesses: [String],
        estimatedMrr: Number, notes: String,
      }],
      marketSize: { tam: String, sam: String, som: String, sources: [String], analyzedAt: Date },
      trends: [{ title: String, description: String, relevance: { type: String, enum: ['low', 'medium', 'high'] }, source: String }],
      benchmarks: { raw: String, analyzedAt: Date },
      marketingPlan: {
        summary: String,
        channels: [{ name: String, strategy: String, budget: String, expectedRoi: String, priority: { type: String, enum: ['low', 'medium', 'high'] }, status: { type: String, enum: ['planned', 'in-progress', 'completed'], default: 'planned' } }],
        actionItems: [{ task: String, channel: String, deadline: String, done: { type: Boolean, default: false } }],
        raw: String, generatedAt: Date,
      },
      lastResearchAt: Date,
    },
    applications: [{
      name: { type: String, required: true, trim: true },
      port: { type: Number, required: true },
      type: { type: String, enum: ['frontend', 'backend', 'fullstack', 'service', 'database'], default: 'fullstack' },
      dockerService: { type: String, default: '', trim: true },
      command: { type: String, default: '', trim: true },
      status: { type: String, enum: ['running', 'stopped', 'building', 'error'], default: 'stopped' },
      tested: { type: Boolean, default: false },
      basePath: { type: String, default: '', trim: true },
      description: { type: String, default: '', trim: true },
      purpose: { type: String, default: '', trim: true },
      testInstructions: { type: String, default: '', trim: true },
      screenshots: [{
        filename: { type: String, required: true },
        originalName: { type: String, default: '' },
        caption: { type: String, default: '' },
        takenBy: { type: String, default: '' },
        takenAt: { type: Date, default: Date.now },
      }],
    }],
    agentSessions: [{
      sessionId: String,
      sdkSessionId: String,
      type: { type: String, enum: ['marketing-research', 'claude-code', 'skill'] },
      status: { type: String, enum: ['running', 'completed', 'failed', 'cancelled'] },
      prompt: String,
      events: [{ type: { type: String }, content: String, tool: String, sessionId: String, timestamp: Date }],
      steps: [{ name: String, status: { type: String, enum: ['pending', 'running', 'completed', 'failed'] }, result: String, startedAt: Date, completedAt: Date }],
      createdAt: { type: Date, default: Date.now },
      completedAt: Date,
    }],
    coachMessages: [{
      role: { type: String, enum: ['user', 'assistant'] },
      content: String,
      actions: [{
        type: { type: String, enum: ['add_todos', 'update_presentation', 'update_field'] },
        items: [String],
        content: String,
        field: String,
        value: String,
        status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
      }],
      timestamp: { type: Date, default: Date.now },
    }],
    sortOrder: { type: Number, default: 0 },
    burndownSortOrder: { type: Number, default: -1 },
  },
  { timestamps: true }
);

export const Project = mongoose.model<IProject>('Project', projectSchema);
