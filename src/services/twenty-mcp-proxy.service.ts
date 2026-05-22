// MCP proxy that sits between AI employees and Twenty's native MCP. Enforces
// per-project scoping: every Company, Person, Opportunity an employee creates
// gets auto-tagged with their project's `twentyProjectId`. Cross-project writes
// (attempting to set a different projectId) are rejected.
//
// Wired in via employee.service.ts: the `twenty` MCP entry points at
// http://localhost:3777/api/companies/:projectId/twenty-mcp which lands here.
import { Project, IProject } from '../models/project.model';
import { Employee } from '../models/employee.model';
import { twentyService } from './twenty.service';

type EnforcementOutcome =
  | { kind: 'allow'; body: any; injected: boolean }
  | { kind: 'reject'; reason: string };

// Tools that write a record with a `project` relation. Twenty MCP exposes
// relations as flat `<name>Id` fields on create inputs. The set is discovered
// dynamically from Twenty's schema (every object that has a `project` field)
// so newly-added objects/relations are auto-enforced without code changes.

class TwentyMcpProxyService {
  /**
   * Proxy a JSON-RPC request from an employee through to Twenty's MCP, after
   * enforcing the per-project scoping policy.
   *
   * Returns the raw response body (SSE text) and content-type to pipe back to
   * the caller. Returns a JSON-RPC error envelope (HTTP 200) if the request is
   * rejected by policy — that's how MCP clients expect errors.
   */
  async proxy(
    projectId: string,
    employeeId: string | null,
    requestBody: any,
    inboundHeaders: Record<string, string>,
  ): Promise<{ status: number; contentType: string; body: string; audit?: AuditEvent }> {
    const project = await Project.findById(projectId).lean();
    if (!project) {
      return this.jsonRpcError(requestBody?.id, 'Unknown project — proxy refusing call');
    }
    const myProjectId = (project as unknown as IProject).twentyProjectId;
    if (!myProjectId) {
      return this.jsonRpcError(requestBody?.id,
        'ProjectsHub project has no twentyProjectId — run twenty-migrate-projects or wait for provisioning');
    }

    const scopedToolNames = await twentyService.getProjectScopedToolNames();
    const enforced = this.enforce(requestBody, myProjectId, scopedToolNames);
    if (enforced.kind === 'reject') {
      return {
        ...this.jsonRpcError(requestBody?.id, enforced.reason),
        audit: { action: 'reject', toolName: this.extractToolName(requestBody), reason: enforced.reason, employeeId, projectId },
      };
    }

    const forwardedBody = JSON.stringify(enforced.body);
    const url = `${twentyService.getBaseUrl()}/mcp`;
    const sessionId = inboundHeaders['mcp-session-id'] || inboundHeaders['Mcp-Session-Id'];
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${twentyService.getAdminApiKey()}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(url, { method: 'POST', headers, body: forwardedBody });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || 'text/event-stream',
      body,
      audit: enforced.injected
        ? { action: 'inject', toolName: this.extractToolName(requestBody), employeeId, projectId, reason: `injected projectId=${myProjectId}` }
        : { action: 'pass', toolName: this.extractToolName(requestBody), employeeId, projectId },
    };
  }

  /** Inspect a JSON-RPC tools/call → execute_tool envelope and apply policy. */
  private enforce(body: any, myProjectId: string, scopedToolNames: Set<string>): EnforcementOutcome {
    if (body?.method !== 'tools/call') return { kind: 'allow', body, injected: false };
    const outerName = body?.params?.name;
    const outerArgs = body?.params?.arguments;
    // Twenty wraps real tools under execute_tool — dig in.
    if (outerName !== 'execute_tool') return { kind: 'allow', body, injected: false };

    const realName = outerArgs?.toolName as string | undefined;
    const realArgs = (outerArgs?.arguments || {}) as any;
    if (!realName) return { kind: 'allow', body, injected: false };

    let injected = false;

    if (scopedToolNames.has(realName)) {
      // Twenty MCP tools take flat top-level args (no `data` wrapper); relations
      // are flat `<name>Id` UUID fields, e.g. `projectId: <uuid>`.
      const existingId = this.readProjectId(realArgs);

      if (existingId && existingId !== myProjectId) {
        return {
          kind: 'reject',
          reason: `cross-project write blocked: ${realName} attempted projectId ${existingId} but this employee is scoped to ${myProjectId}`,
        };
      }
      if (!existingId && realName.startsWith('create_')) {
        realArgs.projectId = myProjectId;
        outerArgs.arguments = realArgs;
        body.params.arguments = outerArgs;
        injected = true;
      }
    }

    return { kind: 'allow', body, injected };
  }

  private readProjectId(data: any): string | undefined {
    if (!data) return undefined;
    if (typeof data.projectId === 'string') return data.projectId;
    if (data.project && typeof data.project === 'object') {
      if (typeof data.project.id === 'string') return data.project.id;
      if (data.project.connect?.id) return data.project.connect.id;
    }
    if (typeof data.project === 'string') return data.project;
    return undefined;
  }

  private extractToolName(body: any): string {
    if (body?.method !== 'tools/call') return body?.method || 'unknown';
    const outer = body?.params?.name;
    if (outer === 'execute_tool') return `execute_tool(${body?.params?.arguments?.toolName || '?'})`;
    return outer || 'unknown';
  }

  private jsonRpcError(id: any, reason: string): { status: number; contentType: string; body: string } {
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32000, message: `[ProjectsHub policy] ${reason}` },
      }),
    };
  }
}

export interface AuditEvent {
  action: 'pass' | 'inject' | 'reject';
  toolName: string;
  projectId: string;
  employeeId: string | null;
  reason?: string;
}

export const twentyMcpProxyService = new TwentyMcpProxyService();
// Re-export for convenience
export { Employee };
