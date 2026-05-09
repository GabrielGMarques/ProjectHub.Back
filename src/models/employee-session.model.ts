import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * One row per SDK session for an employee. A session starts when claudeCodeService
 * spawns a fresh SDK conversation and ends when it's cancelled, dismissed, or crashes.
 * Multiple tasks may run inside the same session via keepAlive message injection.
 */
export interface IEmployeeSession extends Document {
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  projectId: Types.ObjectId;

  /** The internal session map key used by ClaudeCodeService */
  internalSessionId: string;
  /** The Claude SDK's session_id (set after the SDK assigns it) */
  sdkSessionId?: string;

  employeeName: string;
  employeeRole: string;
  projectName: string;
  aiModel: string;

  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;

  /** How the session ended */
  endReason?: 'dismissed' | 'cancelled' | 'completed' | 'failed' | 'restarted';

  /** taskIds (UUIDs) that ran inside this session */
  taskIds: string[];
  /** Number of tasks that ran in this session */
  numTasks: number;

  /** Aggregated token usage across all segments in this session */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  numSegments: number;
  numTurns: number;

  createdAt: Date;
  updatedAt: Date;
}

const employeeSessionSchema = new Schema<IEmployeeSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },

    internalSessionId: { type: String, required: true, index: true },
    sdkSessionId: { type: String, default: '' },

    employeeName: { type: String, default: '' },
    employeeRole: { type: String, default: '' },
    projectName: { type: String, default: '' },
    aiModel: { type: String, default: '' },

    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date },
    durationMs: { type: Number, default: 0 },

    endReason: {
      type: String,
      enum: ['dismissed', 'cancelled', 'completed', 'failed', 'restarted'],
    },

    taskIds: [{ type: String }],
    numTasks: { type: Number, default: 0 },

    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    numSegments: { type: Number, default: 0 },
    numTurns: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Common queries: list sessions ordered by start desc, filtered by user/employee
employeeSessionSchema.index({ userId: 1, startedAt: -1 });
employeeSessionSchema.index({ employeeId: 1, startedAt: -1 });
employeeSessionSchema.index({ projectId: 1, startedAt: -1 });

export const EmployeeSession = mongoose.model<IEmployeeSession>('EmployeeSession', employeeSessionSchema);
