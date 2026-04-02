import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ITokenUsage extends Document {
  userId: Types.ObjectId;
  employeeId?: Types.ObjectId;
  projectId?: Types.ObjectId;
  source: 'employee' | 'alfred' | 'strategic-chat' | 'coach';
  aiModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const tokenUsageSchema = new Schema<ITokenUsage>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    source: { type: String, enum: ['employee', 'alfred', 'strategic-chat', 'coach'], required: true, index: true },
    aiModel: { type: String, default: 'claude-agent-sdk' },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    numTurns: { type: Number, default: 0 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

tokenUsageSchema.index({ createdAt: -1 });
tokenUsageSchema.index({ userId: 1, source: 1, createdAt: -1 });
tokenUsageSchema.index({ userId: 1, employeeId: 1, createdAt: -1 });

export const TokenUsage = mongoose.model<ITokenUsage>('TokenUsage', tokenUsageSchema);
