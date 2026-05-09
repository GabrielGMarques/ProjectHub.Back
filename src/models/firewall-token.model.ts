import mongoose, { Document, Schema } from 'mongoose';

export interface IFirewallToken extends Document {
  /** Public-facing request id (UUID) used while pending */
  requestId: string;
  /** Long-lived secret token written to the cookie (UUID v4, only set after approval) */
  token: string;
  visitorName: string;
  visitorIp: string;
  visitorUserAgent: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedAt?: Date;
  rejectedAt?: Date;
  expiresAt?: Date;
  /** Telegram message id of the approval prompt — used to edit it after a decision */
  telegramMessageId?: number;
  /** One-time share token (UUID) — consumed on first use */
  shareToken?: string;
  /** The app cookie value this share link targets */
  shareApp?: string;
  createdAt: Date;
  updatedAt: Date;
}

const firewallTokenSchema = new Schema<IFirewallToken>({
  requestId:        { type: String, required: true, unique: true, index: true },
  token:            { type: String, default: '',  index: true },
  visitorName:      { type: String, required: true },
  visitorIp:        { type: String, default: '' },
  visitorUserAgent: { type: String, default: '' },
  status:           { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  approvedAt:       { type: Date },
  rejectedAt:       { type: Date },
  expiresAt:        { type: Date, index: true },
  telegramMessageId:{ type: Number },
  shareToken:       { type: String, index: true },
  shareApp:         { type: String, default: '' },
}, { timestamps: true });

// Auto-delete rejected entries after 7 days from last update.
// Approved/pending tokens are kept indefinitely (no TTL).
firewallTokenSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: 'rejected' } },
);

export const FirewallToken = mongoose.model<IFirewallToken>('FirewallToken', firewallTokenSchema);
