import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IManagerLog extends Document {
  userId: Types.ObjectId;
  category: 'message' | 'ai_call' | 'action' | 'watchdog' | 'loop' | 'error' | 'voice';
  direction?: 'inbound' | 'outbound';  // inbound = user msg, outbound = gordon response
  content: string;
  metadata?: Record<string, any>;       // AI timing, action results, error details, etc.
  createdAt: Date;
}

const managerLogSchema = new Schema<IManagerLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: {
      type: String,
      enum: ['message', 'ai_call', 'action', 'watchdog', 'loop', 'error', 'voice'],
      required: true,
    },
    direction: { type: String, enum: ['inbound', 'outbound'] },
    content: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Auto-delete after 24 hours
managerLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
managerLogSchema.index({ userId: 1, createdAt: -1 });
managerLogSchema.index({ userId: 1, category: 1, createdAt: -1 });

export const ManagerLog = mongoose.model<IManagerLog>('ManagerLog', managerLogSchema);
