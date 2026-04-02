import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IManagerInboxMessage extends Document {
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  projectId: Types.ObjectId;
  employeeName: string;
  employeeAvatar: string;
  employeeRole: string;
  projectName: string;
  type: 'issue' | 'question' | 'confirmation' | 'completion' | 'info';
  subject: string;
  body: string;
  read: boolean;
  processedAt?: Date;
  createdAt: Date;
}

const managerInboxSchema = new Schema<IManagerInboxMessage>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    employeeName: { type: String, required: true },
    employeeAvatar: { type: String, default: '' },
    employeeRole: { type: String, default: '' },
    projectName: { type: String, default: '' },
    type: { type: String, enum: ['issue', 'question', 'confirmation', 'completion', 'info'], default: 'info' },
    subject: { type: String, required: true },
    body: { type: String, default: '' },
    read: { type: Boolean, default: false },
    processedAt: { type: Date },
  },
  { timestamps: true }
);

// TTL: auto-delete after 14 days
managerInboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });
managerInboxSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const ManagerInbox = mongoose.model<IManagerInboxMessage>('ManagerInbox', managerInboxSchema);
