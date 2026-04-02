import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IEmployeeMemory extends Document {
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  projectId: Types.ObjectId;
  /** Category: goal, learning, blocker, decision, preference, context */
  category: 'goal' | 'learning' | 'blocker' | 'decision' | 'preference' | 'context';
  content: string;
  /** Source task or compaction run that created this memory */
  source: string;
  /** 0-10 importance score */
  importance: number;
  /** Tags for quick filtering */
  tags: string[];
  /** How many times this memory was injected into a prompt */
  accessCount: number;
  lastAccessedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const employeeMemorySchema = new Schema<IEmployeeMemory>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    category: {
      type: String,
      enum: ['goal', 'learning', 'blocker', 'decision', 'preference', 'context'],
      required: true,
    },
    content: { type: String, required: true },
    source: { type: String, default: '' },
    importance: { type: Number, default: 5, min: 0, max: 10 },
    tags: [{ type: String }],
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date },
  },
  { timestamps: true }
);

employeeMemorySchema.index({ employeeId: 1, category: 1 });
employeeMemorySchema.index({ employeeId: 1, importance: -1 });

export const EmployeeMemory = mongoose.model<IEmployeeMemory>('EmployeeMemory', employeeMemorySchema);
