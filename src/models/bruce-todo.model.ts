import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IBruceTodo extends Document {
  userId: Types.ObjectId;
  text: string;
  done: boolean;
  priority: 'low' | 'normal' | 'high';
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}

const bruceTodoSchema = new Schema<IBruceTodo>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, required: true },
    done: { type: Boolean, default: false },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    category: { type: String },
  },
  { timestamps: true }
);

bruceTodoSchema.index({ userId: 1, done: 1 });

export const BruceTodo = mongoose.model<IBruceTodo>('BruceTodo', bruceTodoSchema);
