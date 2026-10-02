/**
 * Catalog of PostgreSQL extensions shown in the Extensions dialog.
 *
 * - Contrib extensions ship with the server: only their category is listed here.
 * - Third-party extensions must be installed on the server first. Package names were
 *   checked against homebrew-core and the PGDG apt / dnf repositories (PostgreSQL 17).
 *   apt: postgresql-<major>-<apt> (Debian / Ubuntu packages and PGDG use the same names)
 *   dnf: <dnf>_<major> (PGDG for RHEL-like)   fedora: Fedora's own package
 *   brew: formula (builds for @17 and @18)
 *
 * The renderer gets this list through IPC; the main process only runs `brew install`
 * for a formula listed here.
 */

export type ExtensionCategory =
  | 'ai' | 'geo' | 'search' | 'types' | 'analytics' | 'jobs'
  | 'performance' | 'security' | 'integration' | 'dev' | 'other';

export interface CatalogEntry {
  /** Name used by CREATE EXTENSION */
  name: string;
  category: ExtensionCategory;
  /** Ships with PostgreSQL (contrib) */
  contrib?: boolean;
  /** Must be listed in shared_preload_libraries (server restart) */
  preload?: boolean;
  /** Extensions created first (CREATE EXTENSION … CASCADE handles it) */
  requires?: string[];
  brew?: string;
  apt?: string;
  dnf?: string;
  fedora?: string;
  homepage?: string;
}

const contrib = (category: ExtensionCategory, names: string[], extra: Partial<CatalogEntry> = {}): CatalogEntry[] =>
  names.map(name => ({ name, category, contrib: true, ...extra }));

export const EXTENSION_CATALOG: CatalogEntry[] = [
  // --- AI, vectors, graphs
  { name: 'vector', category: 'ai', brew: 'pgvector', apt: 'pgvector', dnf: 'pgvector', fedora: 'pgvector', homepage: 'https://github.com/pgvector/pgvector' },
  { name: 'age', category: 'ai', apt: 'age', dnf: 'age', homepage: 'https://age.apache.org' },

  // --- Geography
  { name: 'postgis', category: 'geo', brew: 'postgis', apt: 'postgis-3', dnf: 'postgis36', fedora: 'postgis', homepage: 'https://postgis.net' },
  { name: 'postgis_raster', category: 'geo', requires: ['postgis'], brew: 'postgis', apt: 'postgis-3', dnf: 'postgis36', fedora: 'postgis', homepage: 'https://postgis.net' },
  { name: 'postgis_topology', category: 'geo', requires: ['postgis'], brew: 'postgis', apt: 'postgis-3', dnf: 'postgis36', fedora: 'postgis', homepage: 'https://postgis.net' },
  { name: 'pgrouting', category: 'geo', requires: ['postgis'], brew: 'pgrouting', apt: 'pgrouting', dnf: 'pgrouting', fedora: 'pgrouting', homepage: 'https://pgrouting.org' },
  { name: 'h3', category: 'geo', apt: 'h3', dnf: 'h3-pg', homepage: 'https://github.com/zachasme/h3-pg' },
  ...contrib('geo', ['earthdistance'], { requires: ['cube'] }),

  // --- Search
  ...contrib('search', ['pg_trgm', 'fuzzystrmatch', 'unaccent', 'btree_gin', 'btree_gist', 'dict_int', 'dict_xsyn']),
  { name: 'rum', category: 'search', apt: 'rum', dnf: 'rum', homepage: 'https://github.com/postgrespro/rum' },
  { name: 'pg_similarity', category: 'search', apt: 'similarity', dnf: 'pg_similarity', homepage: 'https://github.com/eulerto/pg_similarity' },

  // --- Data types
  ...contrib('types', ['citext', 'hstore', 'ltree', 'isn', 'seg', 'cube', 'intarray', 'uuid-ossp', 'lo']),
  { name: 'pg_uuidv7', category: 'types', apt: 'pg-uuidv7', dnf: 'pg_uuidv7', homepage: 'https://github.com/fboulnois/pg_uuidv7' },
  { name: 'ip4r', category: 'types', apt: 'ip4r', dnf: 'ip4r', fedora: 'postgresql-ip4r', homepage: 'https://github.com/RhodiumToad/ip4r' },
  { name: 'semver', category: 'types', apt: 'semver', dnf: 'semver', homepage: 'https://github.com/theory/pg-semver' },
  { name: 'prefix', category: 'types', apt: 'prefix', dnf: 'prefix', homepage: 'https://github.com/dimitri/prefix' },
  { name: 'jsquery', category: 'types', apt: 'jsquery', dnf: 'jsquery', homepage: 'https://github.com/postgrespro/jsquery' },
  { name: 'periods', category: 'types', apt: 'periods', dnf: 'periods', homepage: 'https://github.com/xocolatl/periods' },

  // --- Analytics, time series, scale-out
  { name: 'timescaledb', category: 'analytics', preload: true, apt: 'timescaledb', dnf: 'timescaledb', fedora: 'timescaledb', homepage: 'https://www.timescale.com' },
  { name: 'citus', category: 'analytics', preload: true, brew: 'citus', dnf: 'citus', homepage: 'https://www.citusdata.com' },
  { name: 'hll', category: 'analytics', brew: 'postgresql-hll', apt: 'hll', dnf: 'hll', homepage: 'https://github.com/citusdata/postgresql-hll' },
  { name: 'tdigest', category: 'analytics', apt: 'tdigest', dnf: 'tdigest', homepage: 'https://github.com/tvondra/tdigest' },
  { name: 'pg_ivm', category: 'analytics', apt: 'pg-ivm', dnf: 'pg_ivm', homepage: 'https://github.com/sraoss/pg_ivm' },
  ...contrib('analytics', ['tablefunc']),

  // --- Scheduling, partitions
  { name: 'pg_cron', category: 'jobs', preload: true, brew: 'pg_cron', apt: 'cron', dnf: 'pg_cron', homepage: 'https://github.com/citusdata/pg_cron' },
  { name: 'pg_partman', category: 'jobs', brew: 'pg_partman', apt: 'partman', dnf: 'pg_partman', homepage: 'https://github.com/pgpartman/pg_partman' },

  // --- Performance, maintenance
  ...contrib('performance', ['pg_stat_statements'], { preload: true }),
  ...contrib('performance', ['pg_buffercache', 'pgstattuple', 'pg_prewarm', 'pg_visibility', 'amcheck', 'pg_walinspect', 'pageinspect', 'pg_freespacemap', 'pgrowlocks', 'bloom']),
  { name: 'hypopg', category: 'performance', brew: 'hypopg', apt: 'hypopg', dnf: 'hypopg', homepage: 'https://github.com/HypoPG/hypopg' },
  { name: 'pg_hint_plan', category: 'performance', apt: 'pg-hint-plan', dnf: 'pg_hint_plan', homepage: 'https://github.com/ossc-db/pg_hint_plan' },
  { name: 'pg_qualstats', category: 'performance', preload: true, apt: 'pg-qualstats', dnf: 'pg_qualstats', homepage: 'https://github.com/powa-team/pg_qualstats' },
  { name: 'pg_wait_sampling', category: 'performance', preload: true, apt: 'pg-wait-sampling', dnf: 'pg_wait_sampling', homepage: 'https://github.com/postgrespro/pg_wait_sampling' },
  { name: 'pg_stat_kcache', category: 'performance', preload: true, requires: ['pg_stat_statements'], apt: 'pg-stat-kcache', dnf: 'pg_stat_kcache', homepage: 'https://github.com/powa-team/pg_stat_kcache' },
  { name: 'pg_repack', category: 'performance', apt: 'repack', dnf: 'pg_repack', fedora: 'pg_repack', homepage: 'https://reorg.github.io/pg_repack/' },
  { name: 'pg_squeeze', category: 'performance', preload: true, apt: 'squeeze', dnf: 'pg_squeeze', homepage: 'https://github.com/cybertec-postgresql/pg_squeeze' },

  // --- Security
  ...contrib('security', ['pgcrypto', 'sslinfo']),
  { name: 'pgaudit', category: 'security', preload: true, apt: 'pgaudit', dnf: 'pgaudit', fedora: 'pgaudit', homepage: 'https://www.pgaudit.org' },

  // --- Other databases, HTTP
  ...contrib('integration', ['postgres_fdw', 'dblink', 'file_fdw']),
  { name: 'http', category: 'integration', apt: 'http', dnf: 'pgsql_http', homepage: 'https://github.com/pramsey/pgsql-http' },

  // --- Development
  ...contrib('dev', ['plpgsql', 'tcn', 'moddatetime', 'insert_username', 'autoinc', 'refint', 'tsm_system_rows', 'tsm_system_time', 'xml2', 'pg_surgery']),
  { name: 'pgtap', category: 'dev', apt: 'pgtap', dnf: 'pgtap', homepage: 'https://pgtap.org' },
  { name: 'plpgsql_check', category: 'dev', apt: 'plpgsql-check', dnf: 'plpgsql_check', homepage: 'https://github.com/okbob/plpgsql_check' },
  { name: 'orafce', category: 'dev', apt: 'orafce', dnf: 'orafce', fedora: 'orafce', homepage: 'https://github.com/orafce/orafce' },
];

const BY_NAME = new Map(EXTENSION_CATALOG.map(entry => [entry.name, entry]));

export function catalogEntry(name: string): CatalogEntry | undefined {
  return BY_NAME.get(name);
}

export type PackageManager = 'brew' | 'apt' | 'dnf' | 'fedora';

/** Package providing the extension for this manager and server version, or null */
export function extensionPackage(entry: CatalogEntry, manager: PackageManager, major: number): string | null {
  switch (manager) {
    case 'brew': return entry.brew ?? null;
    case 'apt': return entry.apt ? `postgresql-${major}-${entry.apt}` : null;
    case 'dnf': return entry.dnf ? `${entry.dnf}_${major}` : null;
    case 'fedora': return entry.fedora ?? null;
  }
}

/** Shell command installing the extension's package, or null when there is none for this manager */
export function packageInstallCommand(entry: CatalogEntry, manager: PackageManager, major: number): string | null {
  const pkg = extensionPackage(entry, manager, major);
  if (!pkg) return null;
  if (manager === 'brew') return `brew install ${pkg}`;
  return manager === 'apt' ? `sudo apt install ${pkg}` : `sudo dnf install ${pkg}`;
}

/** Package names come from the catalog only; this guards what reaches a root script anyway */
const PACKAGE_RE = /^[a-z0-9][a-z0-9.+_-]*$/;

/**
 * Root script installing an extension package on Linux (run through one pkexec prompt).
 * Prints "==> [NN%] message" steps like the setup scripts.
 */
export function linuxExtensionScript(entry: CatalogEntry, manager: Exclude<PackageManager, 'brew'>, major: number): string {
  const pkg = extensionPackage(entry, manager, major);
  if (!pkg || !PACKAGE_RE.test(pkg)) throw new Error(`No ${manager} package for ${entry.name}`);
  const install = manager === 'apt'
    ? [
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get -o DPkg::Lock::Timeout=120 update -q || echo "apt-get update reported errors, trying the install anyway"',
      `apt-get -o DPkg::Lock::Timeout=120 install -y -q ${pkg}`,
    ]
    : [`dnf install -y ${pkg}`];
  return [
    '#!/bin/bash',
    `# bbdump: PostgreSQL extension ${entry.name} (${manager})`,
    'set -euo pipefail',
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'step() { echo "==> [$1%] $2"; }',
    '',
    `step 10 "Installing ${pkg}"`,
    ...install,
    '',
    `step 100 "${pkg} installed"`,
  ].join('\n') + '\n';
}

/** 'a, "b c", d' → ['a', 'b c', 'd'] (shared_preload_libraries list syntax, quotes respected) */
export function parseLibraryList(value: string | null | undefined): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  const text = value || '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current.trim());
  return items.filter(Boolean);
}

/** ALTER SYSTEM value: one SQL literal per library ('a', 'b') */
export function preloadLiterals(libraries: string[], literal: (fmt: string, value: string) => string): string {
  return libraries.length ? libraries.map(lib => literal('%L', lib)).join(', ') : "''";
}

/** New shared_preload_libraries value with `name` added (citus has to come first) */
export function withPreloadLibrary(current: string[], name: string): string[] {
  if (current.includes(name)) return current;
  return name === 'citus' ? [name, ...current] : [...current, name];
}
