import { ModelRoutingConfig, IModelRoutingConfig, ModelTier, FACTORY_DEFAULTS } from '../models/model-routing.model';
import { TokenUsage } from '../models/token-usage.model';

/** Cached config per user — avoids DB read on every task */
const configCache = new Map<string, { config: IModelRoutingConfig; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

class ModelRoutingService {

  /** Get config for a user — creates with factory defaults if none exists */
  async getConfig(userId: string): Promise<IModelRoutingConfig> {
    // Check cache
    const cached = configCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.config;

    let config = await ModelRoutingConfig.findOne({ userId });
    if (!config) {
      config = await ModelRoutingConfig.create({
        userId,
        ...FACTORY_DEFAULTS,
      });
    }

    configCache.set(userId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    return config;
  }

  /** Invalidate cache for a user */
  invalidateCache(userId: string): void {
    configCache.delete(userId);
  }

  /**
   * Resolve which model to use for a given context.
   * Precedence: actionRoutes > roleDefaults > globalDefault
   */
  async resolveModel(userId: string, context: {
    action: string;
    role?: string;
    source: 'employee' | 'alfred' | 'strategic';
  }): Promise<ModelTier> {
    const config = await this.getConfig(userId);

    // 1. Check action routes (highest priority)
    const actionRoute = config.actionRoutes.find(r => r.action === context.action);
    if (actionRoute) return actionRoute.model;

    // 2. Check role defaults (employee only)
    if (context.role && context.source === 'employee') {
      const roleDefault = config.roleDefaults.find(r => r.role === context.role);
      if (roleDefault) return roleDefault.model;
    }

    // 3. Global default
    return config.globalDefault;
  }

  /** Get sub-agent defaults for building the delegation prompt */
  async getSubAgentDefaults(userId: string): Promise<IModelRoutingConfig['subAgentDefaults']> {
    const config = await this.getConfig(userId);
    return config.subAgentDefaults;
  }

  /** Check if escalation is allowed and within ceiling */
  async checkEscalation(userId: string, requestedModel: ModelTier): Promise<{ allowed: boolean; reason?: string }> {
    const config = await this.getConfig(userId);
    if (!config.escalation.enabled) {
      return { allowed: false, reason: 'Self-escalation is disabled' };
    }
    const tiers: ModelTier[] = ['haiku', 'sonnet', 'opus'];
    const requested = tiers.indexOf(requestedModel);
    const ceiling = tiers.indexOf(config.escalation.maxEscalation);
    if (requested > ceiling) {
      return { allowed: false, reason: `Requested ${requestedModel} exceeds ceiling ${config.escalation.maxEscalation}` };
    }
    return { allowed: true };
  }

  // ── CRUD ──

  async updateGlobalDefault(userId: string, model: ModelTier): Promise<IModelRoutingConfig> {
    const config = await this.getConfig(userId);
    config.globalDefault = model;
    await config.save();
    this.invalidateCache(userId);
    return config;
  }

  async updateActionRoute(userId: string, action: string, model: ModelTier): Promise<IModelRoutingConfig> {
    const config = await this.getConfig(userId);
    const route = config.actionRoutes.find(r => r.action === action);
    if (route) {
      route.model = model;
    }
    await config.save();
    this.invalidateCache(userId);
    return config;
  }

  async updateRoleDefault(userId: string, role: string, model: ModelTier): Promise<IModelRoutingConfig> {
    const config = await this.getConfig(userId);
    const existing = config.roleDefaults.find(r => r.role === role);
    if (existing) {
      existing.model = model;
    } else {
      config.roleDefaults.push({ role, model });
    }
    await config.save();
    this.invalidateCache(userId);
    return config;
  }

  async removeRoleDefault(userId: string, role: string): Promise<IModelRoutingConfig> {
    const config = await this.getConfig(userId);
    config.roleDefaults = config.roleDefaults.filter(r => r.role !== role);
    await config.save();
    this.invalidateCache(userId);
    return config;
  }

  async updateSubAgentDefaults(userId: string, defaults: Partial<IModelRoutingConfig['subAgentDefaults']>): Promise<IModelRoutingConfig> {
    const config = await this.getConfig(userId);
    if (defaults.exploration) config.subAgentDefaults.exploration = defaults.exploration;
    if (defaults.implementation) config.subAgentDefaults.implementation = defaults.implementation;
    if (defaults.commands) config.subAgentDefaults.commands = defaults.commands;
    if (defaults.testing) config.subAgentDefaults.testing = defaults.testing;
    await config.save();
    this.invalidateCache(userId);
    return config;
  }

  async updateEscalation(userId: string, escalation: { enabled?: boolean; maxEscalation?: ModelTier }): Promise<IModelRoutingConfig> {
    const config = await this.getConfig(userId);
    if (escalation.enabled !== undefined) config.escalation.enabled = escalation.enabled;
    if (escalation.maxEscalation) config.escalation.maxEscalation = escalation.maxEscalation;
    await config.save();
    this.invalidateCache(userId);
    return config;
  }

  async resetToDefaults(userId: string): Promise<IModelRoutingConfig> {
    await ModelRoutingConfig.deleteOne({ userId });
    this.invalidateCache(userId);
    return this.getConfig(userId); // re-creates with defaults
  }

  /** Estimate costs based on recent usage and current config */
  async getCostEstimate(userId: string, days: number = 7): Promise<{
    currentConfig: { daily: number; byModel: Record<string, number> };
    allSonnetBaseline: { daily: number };
    savingsPercent: number;
  }> {
    // Approximate pricing ratios (per million tokens)
    const PRICING: Record<ModelTier, number> = {
      haiku: 0.25,
      sonnet: 3.0,
      opus: 15.0,
    };

    const since = new Date(Date.now() - days * 86400000);
    const records = await TokenUsage.find({ userId, createdAt: { $gte: since } }).lean();

    let currentCost = 0;
    let sonnetBaseline = 0;
    const byModel: Record<string, number> = { haiku: 0, sonnet: 0, opus: 0 };

    for (const r of records) {
      currentCost += r.costUsd || 0;

      // For the baseline: what would it cost if everything was Sonnet?
      const totalTokens = (r.totalTokens || 0) / 1_000_000;
      sonnetBaseline += totalTokens * PRICING.sonnet;

      // Track by model
      const model = (r.aiModel || '').toLowerCase();
      if (model.includes('haiku')) byModel.haiku += r.costUsd || 0;
      else if (model.includes('opus')) byModel.opus += r.costUsd || 0;
      else byModel.sonnet += r.costUsd || 0;
    }

    const dailyCurrent = days > 0 ? currentCost / days : 0;
    const dailySonnet = days > 0 ? sonnetBaseline / days : 0;
    const savingsPercent = dailySonnet > 0 ? Math.round((1 - dailyCurrent / dailySonnet) * 100) : 0;

    return {
      currentConfig: { daily: dailyCurrent, byModel },
      allSonnetBaseline: { daily: dailySonnet },
      savingsPercent,
    };
  }
}

export const modelRoutingService = new ModelRoutingService();
