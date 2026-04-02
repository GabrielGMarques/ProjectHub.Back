import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IWorkingStatusHistory extends Document {
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  projectId: Types.ObjectId;
  employeeName: string;
  employeeRole: string;
  content: string;
  source: 'api' | 'file' | 'manager';
  taskId?: string;
  createdAt: Date;
}

const workingStatusHistorySchema = new Schema<IWorkingStatusHistory>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    employeeName: { type: String, required: true },
    employeeRole: { type: String, required: true },
    content: { type: String, required: true },
    source: { type: String, enum: ['api', 'file', 'manager'], default: 'api' },
    taskId: { type: String },
  },
  { timestamps: true }
);

// Auto-delete after 30 days
workingStatusHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });
workingStatusHistorySchema.index({ employeeId: 1, createdAt: -1 });

export const WorkingStatusHistory = mongoose.model<IWorkingStatusHistory>(
  'WorkingStatusHistory',
  workingStatusHistorySchema
);
