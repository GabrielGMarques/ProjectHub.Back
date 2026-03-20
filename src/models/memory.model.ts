import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IMemoryEntry extends Document {
  userId: Types.ObjectId;

  // Content
  content: string;
  source: 'daily_summary' | 'weekly_summary' | 'conversation' | 'decision' | 'milestone';
  granularity: 'conversation' | 'day' | 'week' | 'month';

  // Temporal — what period this memory covers
  dateRange: {
    start: Date;
    end: Date;
  };

  // Vector embedding (1536-dim from text-embedding-3-small)
  embedding: number[];

  // Metadata for filtering
  projectIds: Types.ObjectId[];
  tags: string[];
  importance: number; // 0-10

  // Hierarchy — weekly summary links to its daily children
  parentMemoryId?: Types.ObjectId;

  // Lifecycle
  accessCount: number;
  lastAccessedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const memoryEntrySchema = new Schema<IMemoryEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    content: { type: String, required: true },
    source: {
      type: String,
      enum: ['daily_summary', 'weekly_summary', 'conversation', 'decision', 'milestone'],
      required: true,
    },
    granularity: {
      type: String,
      enum: ['conversation', 'day', 'week', 'month'],
      required: true,
    },

    dateRange: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },

    embedding: { type: [Number], default: [] },

    projectIds: [{ type: Schema.Types.ObjectId, ref: 'Project' }],
    tags: [{ type: String }],
    importance: { type: Number, default: 5, min: 0, max: 10 },

    parentMemoryId: { type: Schema.Types.ObjectId, ref: 'MemoryEntry' },

    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Query indexes
memoryEntrySchema.index({ userId: 1, createdAt: -1 });
memoryEntrySchema.index({ userId: 1, source: 1, granularity: 1 });
memoryEntrySchema.index({ userId: 1, projectIds: 1 });
memoryEntrySchema.index({ userId: 1, tags: 1 });

export const MemoryEntry = mongoose.model<IMemoryEntry>('MemoryEntry', memoryEntrySchema);
