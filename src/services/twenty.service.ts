// Twenty CRM integration. Architecture: one shared Twenty workspace; each
// ProjectsHub project gets its own Twenty Company record. AI employees are told
// (via system-prompt context) to link any CRM records they create to that
// Company ID, giving us logical per-project isolation without per-workspace
// provisioning gymnastics.
//
// On project creation we POST to Twenty's GraphQL with the admin API key and
// store the returned Company UUID on the Project doc. The frontend iframe
// deep-links to /object/company/<id> so the user sees only that project's CRM.
import { Project, IProject } from '../models/project.model';

interface ProvisionResult {
  projectId: string;
}

const TWENTY_BASE_URL = process.env.TWENTY_BASE_URL || 'http://localhost:3000';
const TWENTY_ADMIN_API_KEY = process.env.TWENTY_ADMIN_API_KEY || '';
const TWENTY_PROVISION_ENABLED = process.env.TWENTY_PROVISION_ENABLED !== 'false';
const TWENTY_WORKSPACE_SUBDOMAIN = process.env.TWENTY_WORKSPACE_SUBDOMAIN || 'projectshub';

class TwentyService {
  /**
   * Idempotent: ensures a Twenty Company record exists for this project and the
   * project doc carries its ID. Marks status pending → provisioned → failed.
   */
  async provisionTwentyProject(project: IProject): Promise<ProvisionResult | null> {
    if (!TWENTY_PROVISION_ENABLED) return null;
    if (!TWENTY_ADMIN_API_KEY) {
      console.warn('[twenty] TWENTY_ADMIN_API_KEY not set — skipping provisioning');
      return null;
    }
    if (project.twentyProjectId) {
      return { projectId: project.twentyProjectId };
    }

    const mongoId = String(project._id);
    await Project.findByIdAndUpdate(mongoId, { twentyProvisionStatus: 'pending' });

    try {
      const created = await this.mcpExecute('create_project', { name: project.name || 'Untitled Project' });
      const twentyProjectId = created?.id || created?.result?.id;
      if (!twentyProjectId) throw new Error(`create_project returned no id: ${JSON.stringify(created).slice(0, 200)}`);

      // Filtered Views: Companies, People, Opportunities scoped to this project.
      const projectWithId = { ...(project.toObject?.() ?? project), twentyProjectId } as IProject;
      const views = await this.createProjectViews(projectWithId).catch(err => {
        console.warn(`[twenty] view creation failed for "${project.name}": ${err.message}`);
        return {} as Awaited<ReturnType<TwentyService['createProjectViews']>>;
      });
      await Project.findByIdAndUpdate(mongoId, {
        twentyProjectId,
        twentyCompaniesViewId: views.companiesViewId || '',
        twentyPeopleViewId: views.peopleViewId || '',
        twentyOpportunitiesViewId: views.opportunitiesViewId || '',
        twentyNotesViewId: views.notesViewId || '',
        twentyProvisionStatus: 'provisioned',
      });
      console.log(`[twenty] provisioned Project ${twentyProjectId.slice(0, 8)}… (+ views: companies=${!!views.companiesViewId}, people=${!!views.peopleViewId}, opps=${!!views.opportunitiesViewId}, notes=${!!views.notesViewId}) for "${project.name}"`);
      return { projectId: twentyProjectId };
    } catch (err: any) {
      console.error(`[twenty] provisioning failed for "${project.name}": ${err.message}`);
      await Project.findByIdAndUpdate(mongoId, { twentyProvisionStatus: 'failed' });
      return null;
    }
  }

  /** @deprecated Use `provisionTwentyProject`. Kept temporarily for migration callers. */
  async provisionTwentyCompany(project: IProject): Promise<ProvisionResult | null> {
    return this.provisionTwentyProject(project);
  }

  /** Shared admin API key. Employees use this same key; per-project scoping is via Company ID, not key. */
  getAdminApiKey(): string {
    return TWENTY_ADMIN_API_KEY;
  }

  getBaseUrl(): string {
    return TWENTY_BASE_URL;
  }

  /** Frontend deep-link URL for this project's Twenty Project record. */
  getProjectDeepLink(twentyProjectId: string): string {
    const u = new URL(TWENTY_BASE_URL);
    const host = `${TWENTY_WORKSPACE_SUBDOMAIN}.${u.hostname}`;
    return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}/object/project/${twentyProjectId}`;
  }

  /** @deprecated Use `getProjectDeepLink`. */
  getCompanyDeepLink(companyId: string): string {
    return this.getProjectDeepLink(companyId);
  }

  /** Fetch the Twenty Project record for the given ID. */
  async getProject(projectId: string): Promise<any> {
    return this.restGet(`/rest/projects/${projectId}`).then(r => r?.data?.project || null);
  }

  /** List Companies linked to the given Project. */
  async listCompaniesByProject(projectId: string, limit = 60): Promise<any[]> {
    const filter = encodeURIComponent(`projectId[eq]:${projectId}`);
    const r = await this.restGet(`/rest/companies?filter=${filter}&limit=${limit}`).catch(() => null);
    return r?.data?.companies || [];
  }

  /** List People linked to the given Project. */
  async listPeopleByProject(projectId: string, limit = 60): Promise<any[]> {
    const filter = encodeURIComponent(`projectId[eq]:${projectId}`);
    const r = await this.restGet(`/rest/people?filter=${filter}&limit=${limit}`).catch(() => null);
    return r?.data?.people || [];
  }

  /** List Opportunities linked to the Project. */
  async listOpportunitiesByProject(projectId: string, limit = 30): Promise<any[]> {
    const filter = encodeURIComponent(`projectId[eq]:${projectId}`);
    const r = await this.restGet(`/rest/opportunities?filter=${filter}&limit=${limit}`).catch(() => null);
    return r?.data?.opportunities || [];
  }

  /** List Notes linked to the Project (with noteTargets included for company lookup). */
  async listNotesByProject(projectId: string, limit = 30): Promise<any[]> {
    const filter = encodeURIComponent(`projectId[eq]:${projectId}`);
    const r = await this.restGet(`/rest/notes?filter=${filter}&limit=${limit}&depth=1`).catch(() => null);
    return r?.data?.notes || [];
  }

  private async restGet(path: string): Promise<any> {
    if (!TWENTY_ADMIN_API_KEY) throw new Error('TWENTY_ADMIN_API_KEY is not set');
    const res = await fetch(`${TWENTY_BASE_URL}${path}`, {
      headers: { 'Authorization': `Bearer ${TWENTY_ADMIN_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Twenty REST ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** Frontend deep-link to a saved View (filtered list). */
  getViewDeepLink(objectNameSingular: 'person' | 'opportunity' | 'company' | 'note', viewId: string): string {
    const u = new URL(TWENTY_BASE_URL);
    const host = `${TWENTY_WORKSPACE_SUBDOMAIN}.${u.hostname}`;
    const plural = objectNameSingular === 'person' ? 'people'
      : objectNameSingular === 'opportunity' ? 'opportunities'
      : objectNameSingular === 'company' ? 'companies'
      : 'notes';
    return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}/objects/${plural}?viewId=${viewId}`;
  }

  /**
   * Create per-project saved Views (Companies, People, Opportunities) filtered by
   * the project's twentyProjectId via the new `project` relation. Returns view IDs.
   */
  async createProjectViews(project: IProject): Promise<{ peopleViewId?: string; opportunitiesViewId?: string; companiesViewId?: string; notesViewId?: string }> {
    if (!project.twentyProjectId || !TWENTY_ADMIN_API_KEY) return {};
    const projectName = (project.name || 'Project').slice(0, 40);
    const out: { peopleViewId?: string; opportunitiesViewId?: string; companiesViewId?: string; notesViewId?: string } = {};

    const fieldIds = await this.getProjectFieldIds().catch(err => {
      console.warn(`[twenty] could not resolve project-field IDs: ${err.message}`);
      return {} as Record<string, string>;
    });

    const targets: Array<{ obj: 'company' | 'person' | 'opportunity' | 'note'; key: 'companiesViewId' | 'peopleViewId' | 'opportunitiesViewId' | 'notesViewId'; existing: string | undefined; label: string; icon: string }> = [
      { obj: 'company', key: 'companiesViewId', existing: project.twentyCompaniesViewId, label: 'Companies', icon: 'IconBuildingSkyscraper' },
      { obj: 'person', key: 'peopleViewId', existing: project.twentyPeopleViewId, label: 'People', icon: 'IconUsers' },
      { obj: 'opportunity', key: 'opportunitiesViewId', existing: project.twentyOpportunitiesViewId, label: 'Opportunities', icon: 'IconTrendingUp' },
      { obj: 'note', key: 'notesViewId', existing: project.twentyNotesViewId, label: 'Notes', icon: 'IconNotes' },
    ];

    for (const t of targets) {
      // Idempotent: skip if the project already has a saved view for this object.
      if (t.existing) {
        out[t.key] = t.existing;
        continue;
      }
      try {
        const view = await this.mcpExecute('create_view', {
          name: `${projectName} — ${t.label}`,
          objectNameSingular: t.obj,
          icon: t.icon,
          type: 'TABLE',
          visibility: 'WORKSPACE',
        });
        const viewId = view?.id || view?.data?.id || view?.view?.id;
        if (!viewId) {
          console.warn(`[twenty] create_view returned no id for ${t.obj}:`, JSON.stringify(view).slice(0, 200));
          continue;
        }
        out[t.key] = viewId;
        const fieldId = fieldIds[t.obj];
        if (fieldId) {
          await this.mcpExecute('create_view_filter', {
            viewId,
            fieldMetadataId: fieldId,
            operand: 'IS',
            value: project.twentyProjectId,
          }).catch(err => console.warn(`[twenty] view filter create failed for ${t.obj}: ${err.message}`));
        }
      } catch (err: any) {
        console.warn(`[twenty] view creation failed for ${t.obj}: ${err.message}`);
      }
    }
    return out;
  }

  private fieldIdsCache: Record<string, string> | null = null;

  /** Resolve fieldMetadataId of the `project` relation field on every object that has one.
   *  Returns map of `nameSingular` → fieldMetadataId. Cached for the process lifetime. */
  async getProjectFieldIds(): Promise<Record<string, string>> {
    if (this.fieldIdsCache) return this.fieldIdsCache;
    const objs = await this.mcpExecute('get_object_metadata', { limit: 100 });
    const objList: any[] = Array.isArray(objs) ? objs : (objs?.records || objs?.items || []);
    const map: Record<string, string> = {};
    for (const o of objList) {
      if (!o?.nameSingular || o?.isSystem || o?.nameSingular === 'project') continue;
      const fields = await this.mcpExecute('get_field_metadata', { objectMetadataId: o.id, limit: 100 });
      const fieldList: any[] = Array.isArray(fields) ? fields : (fields?.records || fields?.items || []);
      const projectField = fieldList.find((f: any) => f?.name === 'project' && f?.type === 'RELATION');
      if (projectField?.id) map[o.nameSingular] = projectField.id;
    }
    this.fieldIdsCache = map;
    return map;
  }

  /** Set of MCP tool names that the proxy must enforce project scoping on.
   *  Discovered dynamically from objects that have a `project` relation. */
  async getProjectScopedToolNames(): Promise<Set<string>> {
    const map = await this.getProjectFieldIds();
    const set = new Set<string>();
    for (const obj of Object.keys(map)) {
      set.add(`create_${obj}`);
      set.add(`update_${obj}`);
    }
    return set;
  }

  /** Force-clear the cache (useful after a schema change like adding a new relation). */
  clearFieldIdsCache(): void { this.fieldIdsCache = null; }

  /** Twenty's MCP exposes 5 meta-tools; real actions go through execute_tool wrapper. */
  private async mcpExecute(realToolName: string, args: any): Promise<any> {
    return this.mcpCall('execute_tool', { toolName: realToolName, arguments: args });
  }

  /** POST a JSON-RPC tools/call to Twenty's native MCP and parse the SSE response. */
  private async mcpCall(toolName: string, args: any): Promise<any> {
    if (!TWENTY_ADMIN_API_KEY) throw new Error('TWENTY_ADMIN_API_KEY is not set');
    const body = {
      jsonrpc: '2.0',
      id: Date.now() + Math.floor(Math.random() * 1000),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };
    const res = await fetch(`${TWENTY_BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TWENTY_ADMIN_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    // SSE response — find the last `data: ` line that has a `result` payload.
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(dataLines[i].slice(6));
        if (obj.error) throw new Error(`MCP error: ${JSON.stringify(obj.error)}`);
        if (obj.result) {
          const wrapper = obj.result?.content?.[0]?.text;
          if (typeof wrapper === 'string') {
            try { return JSON.parse(wrapper); } catch { return wrapper; }
          }
          return obj.result;
        }
      } catch (e) {
        if ((e as Error).message?.startsWith('MCP error:')) throw e;
        // otherwise, this line was a progress notification — skip
      }
    }
    throw new Error(`MCP: no result in response (got ${dataLines.length} data lines)`);
  }

  private async createCompany(name: string, description: string): Promise<string> {
    const res = await fetch(`${TWENTY_BASE_URL}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TWENTY_ADMIN_API_KEY}`,
      },
      body: JSON.stringify({
        // We pass description via the standard `name` field only; Twenty's
        // Company has no description column by default. If you've extended the
        // schema you can wire it in here.
        query: `mutation CreateCompany($data: CompanyCreateInput!) {
          createCompany(data: $data) { id name }
        }`,
        variables: { data: { name } },
      }),
    });
    if (!res.ok) {
      throw new Error(`Twenty GraphQL HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const body: any = await res.json();
    if (body.errors?.length) {
      throw new Error(`Twenty GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    const id = body?.data?.createCompany?.id;
    if (!id) throw new Error(`Twenty GraphQL: no company id in response (body=${JSON.stringify(body).slice(0, 300)})`);
    // description is intentionally unused for now; included in signature for forward-compat
    void description;
    return id;
  }
}

export const twentyService = new TwentyService();
