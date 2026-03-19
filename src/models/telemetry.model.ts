import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ITelemetryEvent extends Document {
  userId: Types.ObjectId;
  projectId?: Types.ObjectId;
  employeeId?: Types.ObjectId;
  type: 'agent_run' | 'employee_task' | 'error' | 'system';
  source: string;       // e.g. 'claude-code', 'employee:backend-developer', 'strategic-chat'
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  description: string;
  error?: string;
  durationMs?: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const telemetrySchema = new Schema<ITelemetryEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    type: { type: String, enum: ['agent_run', 'employee_task', 'error', 'system'], required: true },
    source: { type: String, required: true },
    status: { type: String, enum: ['started', 'completed', 'failed', 'cancelled'], required: true },
    description: { type: String, default: '' },
    error: { type: String },
    durationMs: { type: Number },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

telemetrySchema.index({ createdAt: -1 });
telemetrySchema.index({ userId: 1, type: 1, createdAt: -1 });

export const TelemetryEvent = mongoose.model<ITelemetryEvent>('TelemetryEvent', telemetrySchema);
