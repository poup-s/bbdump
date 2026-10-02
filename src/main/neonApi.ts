/**
 * Neon API v2, with the user's API key: their projects, branches and databases, and the
 * direct (non-pooled) connection URI of one database, to add it without copying anything.
 * https://api-docs.neon.tech/reference/getting-started-with-neon-api
 */

const DEFAULT_BASE = 'https://console.neon.tech/api/v2';
const TIMEOUT_MS = 15000;

let base = DEFAULT_BASE;
/** Tests and the dev app point this at a mock server */
export function setNeonApiBase(url: string | undefined) {
  base = url || DEFAULT_BASE;
}

export class NeonApiError extends Error {
  constructor(message: string, readonly code: 'invalid_key' | 'network' | 'api', readonly status?: number) {
    super(message);
  }
}

export interface NeonProject { id: string; name: string; region: string; org?: string }
export interface NeonBranch { id: string; name: string; default: boolean; state?: string }
export interface NeonDatabase { name: string; owner: string }

const ID = /^[a-z0-9-]{1,60}$/i;
function checkId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new NeonApiError(`Invalid ${what}`, 'api');
  return value;
}

async function get<T>(key: string, path: string, query: Record<string, string | undefined> = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
  const url = `${base}${path}${params.size ? `?${params}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new NeonApiError(`Neon is unreachable: ${error instanceof Error ? error.message : error}`, 'network');
  }
  if (res.status === 401 || res.status === 403) throw new NeonApiError('Neon refused the API key', 'invalid_key', res.status);
  if (!res.ok) {
    let message = '';
    try { message = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* not JSON */ }
    throw new NeonApiError(`Neon API ${res.status}${message ? `: ${message}` : ''}`, 'api', res.status);
  }
  return (await res.json()) as T;
}

interface ProjectsPage { projects: Array<{ id: string; name: string; region_id: string; org_name?: string }>; pagination?: { cursor?: string } }

async function projectsOf(key: string, orgId: string | undefined, orgName: string | undefined): Promise<NeonProject[]> {
  const out: NeonProject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await get<ProjectsPage>(key, '/projects', { org_id: orgId, limit: '400', cursor });
    for (const p of res.projects ?? []) out.push({ id: p.id, name: p.name, region: p.region_id, org: p.org_name ?? orgName });
    cursor = res.pagination?.cursor;
    if (!cursor || (res.projects ?? []).length < 400) break;
  }
  return out;
}

/**
 * Every project the key reaches. A personal key must name the organization of the
 * projects it lists, so they are listed per organization; an organization key lists its own.
 */
export async function listProjects(key: string): Promise<NeonProject[]> {
  let orgs: Array<{ id: string; name: string }> = [];
  try {
    orgs = (await get<{ organizations?: Array<{ id: string; name: string }> }>(key, '/users/me/organizations')).organizations ?? [];
  } catch (error) {
    if (error instanceof NeonApiError && error.code !== 'api') throw error;
  }
  if (orgs.length === 0) return projectsOf(key, undefined, undefined);
  const lists = await Promise.all(orgs.map(o => projectsOf(key, o.id, o.name)));
  const seen = new Set<string>();
  return lists.flat().filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** The default branch first, then the most recently updated (Neon's order) */
export async function listBranches(key: string, projectId: string): Promise<NeonBranch[]> {
  const res = await get<{ branches: Array<{ id: string; name: string; default?: boolean; primary?: boolean; current_state?: string }> }>(
    key, `/projects/${checkId(projectId, 'project id')}/branches`,
  );
  const branches = (res.branches ?? []).map(b => ({ id: b.id, name: b.name, default: !!(b.default ?? b.primary), state: b.current_state }));
  return [...branches.filter(b => b.default), ...branches.filter(b => !b.default)];
}

export async function listDatabases(key: string, projectId: string, branchId: string): Promise<NeonDatabase[]> {
  const res = await get<{ databases: Array<{ name: string; owner_name: string }> }>(
    key, `/projects/${checkId(projectId, 'project id')}/branches/${checkId(branchId, 'branch id')}/databases`,
  );
  return (res.databases ?? []).map(d => ({ name: d.name, owner: d.owner_name }));
}

/** The direct endpoint (not "-pooler": pg_dump needs a session), password included */
export async function connectionUri(key: string, projectId: string, branchId: string, database: string, role: string): Promise<string> {
  if (typeof database !== 'string' || !database || typeof role !== 'string' || !role) throw new NeonApiError('Database and role are required', 'api');
  const res = await get<{ uri: string }>(key, `/projects/${checkId(projectId, 'project id')}/connection_uri`, {
    branch_id: checkId(branchId, 'branch id'), database_name: database, role_name: role, pooled: 'false',
  });
  if (typeof res.uri !== 'string' || !/^postgres(ql)?:\/\//.test(res.uri)) throw new NeonApiError('Neon returned no connection URI', 'api');
  return res.uri;
}
