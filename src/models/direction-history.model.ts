import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IDirectionHistory extends Document {
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  projectName: string;
  content: string;
  source: 'alfred' | 'ceo' | 'user' | 'cycle';
  authorName?: string;
  authorRole?: string;
  createdAt: Date;
}

const directionHistorySchema = new Schema<IDirectionHistory>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    projectName: { type: String, required: true },
    content: { type: String, required: true },
    source: { type: String, enum: ['alfred', 'ceo', 'user', 'cycle'], default: 'alfred' },
    authorName: { type: String },
    authorRole: { type: String },
  },
  { timestamps: true }
);

// Auto-delete after 90 days
directionHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });
directionHistorySchema.index({ projectId: 1, createdAt: -1 });

export const DirectionHistory = mongoose.model<IDirectionHistory>(
  'DirectionHistory',
  directionHistorySchema
);
