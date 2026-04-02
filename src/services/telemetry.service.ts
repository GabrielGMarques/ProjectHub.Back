import { TelemetryEvent } from '../models/telemetry.model';

export class TelemetryService {

  async track(data: {
    userId: string;
    projectId?: string;
    employeeId?: string;
    type: 'agent_run' | 'employee_task' | 'error' | 'system';
    source: string;
    status: 'started' | 'completed' | 'failed' | 'cancelled';
    description: string;
    error?: string;
    durationMs?: number;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      await TelemetryEvent.create(data);
    } catch { /* don't let telemetry failures break app */ }
  }

  async getEvents(userId: string, filters?: {
    type?: string;
    status?: string;
    source?: string;
    projectId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ events: any[]; total: number }> {
    const query: any = { userId };
    if (filters?.type) query.type = filters.type;
    if (filters?.status) query.status = filters.status;
    if (filters?.source) query.source = filters.source;
    if (filters?.projectId) query.projectId = filters.projectId;

    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    const [events, total] = await Promise.all([
      TelemetryEvent.find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate('projectId', 'name')
        .populate('employeeId', 'name avatar role')
        .lean(),
      TelemetryEvent.countDocuments(query),
    ]);

    return { events, total };
  }

  async getStats(userId: string, days: number = 7): Promise<{
    totalRuns: number;
    completed: number;
    failed: number;
    cancelled: number;
    avgDurationMs: number;
    errorCount: number;
    dailyBreakdown: { date: string; completed: number; failed: number; total: number }[];
    sourceBreakdown: { source: string; count: number }[];
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const events = await TelemetryEvent.find({
      userId,
      createdAt: { $gte: since },
      type: { $in: ['agent_run', 'employee_task'] },
    }).lean();

    const completed = events.filter(e => e.status === 'completed').length;
    const failed = events.filter(e => e.status === 'failed').length;
    const cancelled = events.filter(e => e.status === 'cancelled').length;
    const durations = events.filter(e => e.durationMs && e.durationMs > 0).map(e => e.durationMs!);
    const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

    const errorCount = await TelemetryEvent.countDocuments({
      userId,
      createdAt: { $gte: since },
      type: 'error',
    });

    // Daily breakdown
    const dailyMap = new Map<string, { completed: number; failed: number; total: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      dailyMap.set(key, { completed: 0, failed: 0, total: 0 });
    }
    for (const e of events) {
      const key = new Date(e.createdAt).toISOString().split('T')[0];
      const day = dailyMap.get(key);
      if (day) {
        day.total++;
        if (e.status === 'completed') day.completed++;
        if (e.status === 'failed') day.failed++;
      }
    }
    const dailyBreakdown = Array.from(dailyMap.entries())
      .map(([date, data]) => ({ date, ...data }))
      .reverse();

    // Source breakdown
    const sourceMap = new Map<string, number>();
    for (const e of events) {
      sourceMap.set(e.source, (sourceMap.get(e.source) || 0) + 1);
    }
    const sourceBreakdown = Array.from(sourceMap.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalRuns: events.length,
      completed,
      failed,
      cancelled,
      avgDurationMs,
      errorCount,
      dailyBreakdown,
      sourceBreakdown,
    };
  }

  async getErrors(userId: string, limit: number = 50): Promise<any[]> {
    return TelemetryEvent.find({ userId, type: 'error' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('projectId', 'name')
      .populate('employeeId', 'name avatar')
      .lean();
  }

  /** Get all events from the last N hours, grouped by source (agent/employee) */
  async getExecutionLog(userId: string, hours: number = 48): Promise<{
    groups: {
      source: string;
      employeeId?: any;
      projectId?: any;
      events: any[];
      stats: { total: number; completed: number; failed: number; started: number; cancelled: number; totalDurationMs: number };
    }[];
    summary: { total: number; completed: number; failed: number; activeNow: number };
  }> {
    const since = new Date(Date.now() - hours * 3600000);

    const events = await TelemetryEvent.find({
      userId,
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .populate('projectId', 'name')
      .populate('employeeId', 'name avatar role title')
      .lean();

    // Group by source + employeeId combination
    const groupMap = new Map<string, {
      source: string;
      employeeId?: any;
      projectId?: any;
      events: any[];
    }>();

    for (const ev of events) {
      const empKey = ev.employeeId?._id?.toString() || '';
      const key = `${ev.source}::${empKey}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          source: ev.source,
          employeeId: ev.employeeId || undefined,
          projectId: ev.projectId || undefined,
          events: [],
        });
      }
      groupMap.get(key)!.events.push(ev);
    }

    // Compute stats per group
    const groups = Array.from(groupMap.values()).map(g => {
      const completed = g.events.filter(e => e.status === 'completed').length;
      const failed = g.events.filter(e => e.status === 'failed').length;
      const started = g.events.filter(e => e.status === 'started').length;
      const cancelled = g.events.filter(e => e.status === 'cancelled').length;
      const totalDurationMs = g.events
        .filter(e => e.durationMs && e.durationMs > 0)
        .reduce((sum, e) => sum + e.durationMs, 0);

      return {
        ...g,
        stats: { total: g.events.length, completed, failed, started, cancelled, totalDurationMs },
      };
    }).sort((a, b) => {
      // Sort: most recent first (by latest event timestamp)
      const aTime = a.events[0]?.createdAt?.getTime() || 0;
      const bTime = b.events[0]?.createdAt?.getTime() || 0;
      return bTime - aTime;
    });

    const allCompleted = events.filter(e => e.status === 'completed').length;
    const allFailed = events.filter(e => e.status === 'failed').length;
    const activeNow = events.filter(e => e.status === 'started').length;

    return {
      groups,
      summary: { total: events.length, completed: allCompleted, failed: allFailed, activeNow },
    };
  }
}
