import { EmployeeSession, IEmployeeSession } from '../models/employee-session.model';
import { EmployeeLog } from '../models/employee-log.model';
import { Types } from 'mongoose';

export interface SessionStartParams {
  userId: string;
  employeeId: string;
  projectId: string;
  internalSessionId: string;
  sdkSessionId?: string;
  employeeName: string;
  employeeRole: string;
  projectName: string;
  aiModel: string;
  taskId?: string;
}

export interface SessionUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  numTurns?: number;
}

/**
 * Tracks per-session lifecycle and aggregated token usage. Each row corresponds
 * to one SDK conversation lifetime — from spawn to dismiss/cancel/end.
 */
export class EmployeeSessionService {
  /** Begin tracking a new session. Idempotent on (employeeId, internalSessionId). */
  async start(params: SessionStartParams): Promise<IEmployeeSession | null> {
    try {
      // Idempotency: if a session with this internalSessionId already exists and
      // is still open, return it instead of creating a duplicate.
      const existing = await EmployeeSession.findOne({
        employeeId: new Types.ObjectId(params.employeeId),
        internalSessionId: params.internalSessionId,
        endedAt: { $exists: false },
      });
      if (existing) {
        if (params.taskId && !existing.taskIds.includes(params.taskId)) {
          existing.taskIds.push(params.taskId);
          existing.numTasks = existing.taskIds.length;
          await existing.save();
        }
        if (params.sdkSessionId && !existing.sdkSessionId) {
          existing.sdkSessionId = params.sdkSessionId;
          await existing.save();
        }
        return existing;
      }

      const session = await EmployeeSession.create({
        userId: new Types.ObjectId(params.userId),
        employeeId: new Types.ObjectId(params.employeeId),
        projectId: new Types.ObjectId(params.projectId),
        internalSessionId: params.internalSessionId,
        sdkSessionId: params.sdkSessionId || '',
        employeeName: params.employeeName,
        employeeRole: params.employeeRole,
        projectName: params.projectName,
        aiModel: params.aiModel,
        startedAt: new Date(),
        taskIds: params.taskId ? [params.taskId] : [],
        numTasks: params.taskId ? 1 : 0,
      });
      return session;
    } catch (err) {
      console.error('[EmployeeSessionService] start failed:', err);
      return null;
    }
  }

  /** Record a sdk session_id once it's known (often arrives after start). */
  async recordSdkSessionId(internalSessionId: string, sdkSessionId: string): Promise<void> {
    try {
      await EmployeeSession.findOneAndUpdate(
        { internalSessionId, endedAt: { $exists: false } },
        { $set: { sdkSessionId } }
      );
    } catch { /* best effort */ }
  }

  /** Append a new task UUID to a still-open session. */
  async addTask(internalSessionId: string, taskId: string): Promise<void> {
    try {
      await EmployeeSession.findOneAndUpdate(
        { internalSessionId, endedAt: { $exists: false } },
        { $addToSet: { taskIds: taskId }, $inc: { numTasks: 0 } }
      );
      // numTasks needs to be set to taskIds.length — refetch + save
      const s = await EmployeeSession.findOne({ internalSessionId, endedAt: { $exists: false } });
      if (s && s.numTasks !== s.taskIds.length) {
        s.numTasks = s.taskIds.length;
        await s.save();
      }
    } catch { /* best effort */ }
  }

  /** Increment token usage on a still-open session. */
  async addUsage(internalSessionId: string, delta: SessionUsageDelta): Promise<void> {
    try {
      const inc: any = {};
      if (delta.inputTokens) inc.inputTokens = delta.inputTokens;
      if (delta.outputTokens) inc.outputTokens = delta.outputTokens;
      if (delta.cacheReadTokens) inc.cacheReadTokens = delta.cacheReadTokens;
      if (delta.cacheCreationTokens) inc.cacheCreationTokens = delta.cacheCreationTokens;
      if (delta.costUsd) inc.costUsd = delta.costUsd;
      if (delta.numTurns) inc.numTurns = delta.numTurns;

      const totalDelta = (delta.inputTokens || 0) + (delta.outputTokens || 0) +
        (delta.cacheReadTokens || 0) + (delta.cacheCreationTokens || 0);
      if (totalDelta) inc.totalTokens = totalDelta;
      inc.numSegments = 1;

      if (Object.keys(inc).length === 0) return;
      await EmployeeSession.findOneAndUpdate(
        { internalSessionId, endedAt: { $exists: false } },
        { $inc: inc }
      );
    } catch { /* best effort */ }
  }

  /** Mark a session ended. Idempotent — only sets endedAt if not already set. */
  async end(internalSessionId: string, reason: IEmployeeSession['endReason']): Promise<void> {
    try {
      const s = await EmployeeSession.findOne({ internalSessionId, endedAt: { $exists: false } });
      if (!s) return;
      s.endedAt = new Date();
      s.durationMs = s.endedAt.getTime() - s.startedAt.getTime();
      s.endReason = reason;
      await s.save();
    } catch { /* best effort */ }
  }

  /** List sessions for one employee, newest first. */
  async getByEmployee(employeeId: string, limit = 50): Promise<IEmployeeSession[]> {
    return EmployeeSession.find({ employeeId: new Types.ObjectId(employeeId) })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean() as any;
  }

  /** List all sessions for a user, newest first, paginated. */
  async getAll(userId: string, page = 1, pageSize = 50): Promise<{
    sessions: IEmployeeSession[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const skip = (page - 1) * pageSize;
    const filter = { userId: new Types.ObjectId(userId) };
    const [sessions, total] = await Promise.all([
      EmployeeSession.find(filter)
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean() as any,
      EmployeeSession.countDocuments(filter),
    ]);
    return { sessions, total, page, pageSize };
  }

  /** Get one session by id, with tasks and logs that ran during its lifetime. */
  async getById(sessionId: string, userId: string): Promise<{
    session: IEmployeeSession;
    logs: any[];
  } | null> {
    const session = await EmployeeSession.findOne({
      _id: new Types.ObjectId(sessionId),
      userId: new Types.ObjectId(userId),
    }).lean() as any;
    if (!session) return null;

    // Pull logs for this employee in the session's time window
    const startedAt = session.startedAt;
    const endedAt = session.endedAt || new Date();
    const logs = await EmployeeLog.find({
      employeeId: session.employeeId,
      createdAt: { $gte: startedAt, $lte: endedAt },
    })
      .sort({ createdAt: 1 })
      .limit(2000)
      .lean();

    return { session, logs };
  }
}

export const employeeSessionService = new EmployeeSessionService();
