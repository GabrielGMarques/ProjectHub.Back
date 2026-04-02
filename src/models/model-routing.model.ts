import mongoose, { Document, Schema, Types } from 'mongoose';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface IRoleDefault {
  role: string;
  model: ModelTier;
}

export interface IActionRoute {
  action: string;
  model: ModelTier;
  label: string;
  category: 'employee' | 'alfred' | 'strategic';
}

export interface ISubAgentDefaults {
  exploration: 'haiku' | 'sonnet';
  implementation: 'sonnet' | 'opus';
  commands: 'haiku' | 'sonnet';
  testing: 'sonnet' | 'opus';
}

export interface IModelRoutingConfig extends Document {
  userId: Types.ObjectId;
  globalDefault: ModelTier;
  roleDefaults: IRoleDefault[];
  actionRoutes: IActionRoute[];
  subAgentDefaults: ISubAgentDefaults;
  escalation: {
    enabled: boolean;
    maxEscalation: ModelTier;
  };
  schemaVersion: number;
  updatedAt: Date;
}

const roleDefaultSchema = new Schema<IRoleDefault>(
  { role: { type: String, required: true }, model: { type: String, enum: ['haiku', 'sonnet', 'opus'], required: true } },
  { _id: false },
);

const actionRouteSchema = new Schema<IActionRoute>(
  {
    action: { type: String, required: true },
    model: { type: String, enum: ['haiku', 'sonnet', 'opus'], required: true },
    label: { type: String, required: true },
    category: { type: String, enum: ['employee', 'alfred', 'strategic'], required: true },
  },
  { _id: false },
);

const modelRoutingConfigSchema = new Schema<IModelRoutingConfig>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    globalDefault: { type: String, enum: ['haiku', 'sonnet', 'opus'], default: 'opus' },
    roleDefaults: [roleDefaultSchema],
    actionRoutes: [actionRouteSchema],
    subAgentDefaults: {
      exploration: { type: String, enum: ['haiku', 'sonnet'], default: 'haiku' },
      implementation: { type: String, enum: ['sonnet', 'opus'], default: 'sonnet' },
      commands: { type: String, enum: ['haiku', 'sonnet'], default: 'haiku' },
      testing: { type: String, enum: ['sonnet', 'opus'], default: 'sonnet' },
    },
    escalation: {
      enabled: { type: Boolean, default: true },
      maxEscalation: { type: String, enum: ['haiku', 'sonnet', 'opus'], default: 'opus' },
    },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

export const ModelRoutingConfig = mongoose.model<IModelRoutingConfig>(
  'ModelRoutingConfig',
  modelRoutingConfigSchema,
);

/** Factory defaults — used to seed new configs and for reset */
export const FACTORY_DEFAULTS = {
  globalDefault: 'opus' as ModelTier,
  roleDefaults: [
    { role: 'ceo', model: 'opus' as ModelTier },
    { role: 'cto', model: 'opus' as ModelTier },
    { role: 'fullstack-developer', model: 'opus' as ModelTier },
    { role: 'frontend-developer', model: 'opus' as ModelTier },
    { role: 'backend-developer', model: 'opus' as ModelTier },
    { role: 'devops-engineer', model: 'opus' as ModelTier },
    { role: 'product-manager', model: 'sonnet' as ModelTier },
    { role: 'ui-ux-designer', model: 'sonnet' as ModelTier },
  ],
  actionRoutes: [
    { action: 'self_eval', model: 'haiku' as ModelTier, label: 'Self-evaluation on restart', category: 'employee' as const },
    { action: 'answer_question', model: 'sonnet' as ModelTier, label: 'Answering Alfred questions', category: 'employee' as const },
    { action: 'dev_task', model: 'opus' as ModelTier, label: 'Development task', category: 'employee' as const },
    { action: 'test_task', model: 'opus' as ModelTier, label: 'Testing task', category: 'employee' as const },
    { action: 'ceo_direction', model: 'opus' as ModelTier, label: 'CEO strategic direction', category: 'strategic' as const },
    { action: 'memory_compaction', model: 'sonnet' as ModelTier, label: 'Memory compaction', category: 'employee' as const },
    { action: 'proactive_scan', model: 'haiku' as ModelTier, label: 'Alfred proactive scans', category: 'alfred' as const },
    { action: 'alfred_message', model: 'sonnet' as ModelTier, label: 'Alfred message responses', category: 'alfred' as const },
    { action: 'alfred_watchdog', model: 'sonnet' as ModelTier, label: 'Alfred watchdog recovery', category: 'alfred' as const },
    { action: 'alfred_wakeup', model: 'sonnet' as ModelTier, label: 'Alfred wake-up briefing', category: 'alfred' as const },
    { action: 'alfred_hands_on', model: 'sonnet' as ModelTier, label: 'Alfred hands-on investigation', category: 'alfred' as const },
    { action: 'memory_summary', model: 'haiku' as ModelTier, label: 'Memory summarization', category: 'alfred' as const },
    { action: 'unanswered_recovery', model: 'haiku' as ModelTier, label: 'Unanswered message recovery', category: 'alfred' as const },
  ],
  subAgentDefaults: {
    exploration: 'haiku' as const,
    implementation: 'sonnet' as const,
    commands: 'haiku' as const,
    testing: 'sonnet' as const,
  },
  escalation: { enabled: true, maxEscalation: 'opus' as ModelTier },
};
