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

export interface IAgentSession {
  sessionId: string;
  type: 'marketing-research' | 'claude-code' | 'skill';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  steps: IAgentStep[];
  createdAt: Date;
  completedAt?: Date;
}

export interface IProject extends Document {
  userId: Types.ObjectId;
  name: string;
  description: string;
  backgroundImage: string;
  githubRepos: string[];
  localPath: string;
  mrr: number;
  clientCount: number;
  impact: 'low' | 'medium' | 'high';
  niche: string;
  timeConsumption: number;
  todos: ITodo[];
  presentation: string;
  monetizationPlan: string;
  schedule: IWeeklySchedule;
  documents: IDocument[];
  marketingResearch: IMarketingResearch;
  agentSessions: IAgentSession[];
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
    mrr: { type: Number, default: 0, min: 0 },
    clientCount: { type: Number, default: 0, min: 0 },
    impact: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    niche: { type: String, default: '', trim: true },
    timeConsumption: { type: Number, default: 0, min: 0 },
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
    agentSessions: [{
      sessionId: String,
      type: { type: String, enum: ['marketing-research', 'claude-code', 'skill'] },
      status: { type: String, enum: ['running', 'completed', 'failed', 'cancelled'] },
      steps: [{ name: String, status: { type: String, enum: ['pending', 'running', 'completed', 'failed'] }, result: String, startedAt: Date, completedAt: Date }],
      createdAt: { type: Date, default: Date.now },
      completedAt: Date,
    }],
    sortOrder: { type: Number, default: 0 },
    burndownSortOrder: { type: Number, default: -1 },
  },
  { timestamps: true }
);

export const Project = mongoose.model<IProject>('Project', projectSchema);
