import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IProject extends Document {
  userId: Types.ObjectId;
  name: string;
  description: string;
  backgroundImage: string;
  githubRepos: string[];
  mrr: number;
  clientCount: number;
  impact: 'low' | 'medium' | 'high';
  niche: string;
  timeConsumption: number;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    backgroundImage: { type: String, default: '' },
    githubRepos: [{ type: String }],
    mrr: { type: Number, default: 0, min: 0 },
    clientCount: { type: Number, default: 0, min: 0 },
    impact: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    niche: { type: String, default: '', trim: true },
    timeConsumption: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

export const Project = mongoose.model<IProject>('Project', projectSchema);
