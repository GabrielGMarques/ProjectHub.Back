import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IEmployeeLog extends Document {
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  projectId: Types.ObjectId;
  category: 'task_start' | 'task_complete' | 'task_fail' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'comms';
  employeeName: string;
  employeeAvatar: string;
  employeeRole: string;
  projectName: string;
  content: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const employeeLogSchema = new Schema<IEmployeeLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    category: {
      type: String,
      enum: ['task_start', 'task_complete', 'task_fail', 'tool_use', 'tool_result', 'text', 'error', 'comms'],
      required: true,
    },
    employeeName: { type: String, required: true },
    employeeAvatar: { type: String, default: '' },
    employeeRole: { type: String, required: true },
    projectName: { type: String, default: '' },
    content: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Auto-delete after 7 weeks (49 days)
employeeLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 4233600 });
employeeLogSchema.index({ userId: 1, createdAt: -1 });
employeeLogSchema.index({ employeeId: 1, createdAt: -1 });
employeeLogSchema.index({ userId: 1, employeeId: 1, createdAt: -1 });

export const EmployeeLog = mongoose.model<IEmployeeLog>('EmployeeLog', employeeLogSchema);
