/**
 * Cloud PostgreSQL hosts: where to find the connection URL, how to recognize one, and the
 * pooled URLs that suit an app but not pg_dump (transaction pooling breaks its session).
 */

export type ProviderId = 'supabase' | 'neon' | 'railway' | 'render' | 'rds' | 'scaleway';

export interface CloudProvider {
  id: ProviderId;
  name: string;
  color: string;
  /** Where the connection string is, opened in the browser */
  dashboardUrl?: string;
  placeholder?: string;
  /** Shown as a guide in the add dialog (the others are only recognized) */
  guide: boolean;
}

export const PROVIDERS: CloudProvider[] = [
  { id: 'supabase', name: 'Supabase', color: '#3ECF8E', guide: true, dashboardUrl: 'https://supabase.com/dashboard/projects',
    placeholder: 'postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres' },
  { id: 'neon', name: 'Neon', color: '#00E599', guide: true, dashboardUrl: 'https://console.neon.tech/app/projects',
    placeholder: 'postgresql://[user]:[password]@ep-[name].[region].aws.neon.tech/neondb?sslmode=require' },
  { id: 'railway', name: 'Railway', color: '#8B5CF6', guide: true, dashboardUrl: 'https://railway.com/dashboard',
    placeholder: 'postgresql://postgres:[password]@[proxy].proxy.rlwy.net:[port]/railway' },
  { id: 'render', name: 'Render', color: '#6366F1', guide: true, dashboardUrl: 'https://dashboard.render.com',
    placeholder: 'postgresql://[user]:[password]@dpg-[id].[region]-postgres.render.com/[database]' },
  { id: 'rds', name: 'AWS RDS', color: '#F59E0B', guide: false },
  { id: 'scaleway', name: 'Scaleway', color: '#7C3AED', guide: false },
];

/** The host a URL points to, by its domain; null for anything else (own server, localhost…) */
export function detectProvider(host: string): CloudProvider | null {
  const h = host.toLowerCase();
  const id: ProviderId | null =
    /(^|\.)supabase\.(co|com)$/.test(h) ? 'supabase'
      : /(^|\.)neon\.tech$/.test(h) ? 'neon'
        : /(^|\.)(rlwy\.net|railway\.app|railway\.internal)$/.test(h) ? 'railway'
          : /(^|\.)render\.com$/.test(h) ? 'render'
            : /\.rds\.amazonaws\.com$/.test(h) ? 'rds'
              : /\.scw\.cloud$/.test(h) ? 'scaleway'
                : null;
  return id ? PROVIDERS.find(p => p.id === id)! : null;
}

export interface PoolerAdvice {
  provider: 'supabase' | 'neon';
  /** The same database, through a connection pg_dump can use */
  fixedUrl: string;
}

/**
 * A pooled URL in transaction mode (Supabase port 6543, Neon "-pooler" host): fine for an
 * app, but pg_dump needs one session. Returns the URL to use instead, or null.
 */
export function poolerAdvice(url: string, host: string, port: number): PoolerAdvice | null {
  const h = host.toLowerCase();
  // Supabase: the same pooler in session mode is on 5432 (the direct host is IPv6 only)
  if (/\.pooler\.supabase\.com$/.test(h) && port === 6543) {
    return { provider: 'supabase', fixedUrl: url.replace(/(@[^/?#]*\.pooler\.supabase\.com):6543/i, '$1:5432') };
  }
  // Neon: the direct endpoint is the same host without "-pooler"
  if (/-pooler\.[^.]+.*\.neon\.tech$/.test(h)) {
    return { provider: 'neon', fixedUrl: url.replace(/(@[^/?#]*?)-pooler\./i, '$1.') };
  }
  return null;
}

/** Whether the URL itself says how to use SSL */
export const urlSetsSsl = (url: string) => /[?&](sslmode|ssl)=/i.test(url);

/** A copied URL whose password is still the host's placeholder ("[YOUR-PASSWORD]", "[password]") */
export const hasPasswordPlaceholder = (url: string) => /\[[^\]]*password[^\]]*\]/i.test(url);
