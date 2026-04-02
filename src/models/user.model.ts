import mongoose, { Document, Schema } from 'mongoose';

export interface IStrategicAction {
  type: 'add_todos' | 'update_field' | 'create_project' | 'run_agent' | 'prioritize';
  projectId?: string;
  projectName?: string;
  items?: string[];
  field?: string;
  value?: string;
  prompt?: string;
  projectIds?: string[];
  status: 'pending' | 'accepted' | 'rejected';
}

export interface IStrategicMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: IStrategicAction[];
  timestamp: Date;
}

export interface IManagerMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface IUser extends Document {
  githubId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  accessToken: string;
  strategicChatMessages: IStrategicMessage[];
  managerChatMessages: IManagerMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    githubId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    displayName: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    accessToken: { type: String, required: true },
    managerChatMessages: [{
      role: { type: String, enum: ['user', 'assistant'] },
      content: String,
      timestamp: { type: Date, default: Date.now },
    }],
    strategicChatMessages: [{
      role: { type: String, enum: ['user', 'assistant'] },
      content: String,
      actions: [{
        type: { type: String, enum: ['add_todos', 'update_field', 'create_project', 'run_agent', 'prioritize'] },
        projectId: String,
        projectName: String,
        items: [String],
        field: String,
        value: String,
        prompt: String,
        projectIds: [String],
        status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
      }],
      timestamp: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', userSchema);
