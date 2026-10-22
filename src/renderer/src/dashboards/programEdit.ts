/**
 * Changes made to a dashboard by hand, without the AI: move, remove, duplicate a block,
 * change a chart's type, rename it, change the SQL of a query. A program is one statement
 * per line (`name = Expression`); each change rewrites the statements concerned and leaves
 * the others as they are. Pure: tested without a window.
 */

export interface Statement { name: string; expr: string }

const STATEMENT = /^(\$?[A-Za-z_]\w*)\s*=\s*(.*)$/;

export function parseStatements(program: string): Statement[] {
  const out: Statement[] = [];
  for (const line of program.split('\n')) {
    const m = STATEMENT.exec(line);
    if (m) out.push({ name: m[1], expr: m[2].trim() });
    else if (line.trim() && out.length) out[out.length - 1].expr += `\n${line}`;
  }
  return out;
}

export const serialize = (statements: Statement[]) => statements.map(s => `${s.name} = ${s.expr}`).join('\n');

/** Top-level pieces of a list, outside strings and brackets: "a, [b, c], "d, e"" → 3 pieces */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last || parts.length) parts.push(last);
  return parts;
}

/** `Callee(a, b)` → { callee, args } (null for anything else) */
export function parseCall(expr: string): { callee: string; args: string[] } | null {
  const m = /^([A-Z]\w*)\(([\s\S]*)\)$/.exec(expr.trim());
  return m ? { callee: m[1], args: splitTopLevel(m[2]) } : null;
}

export const formatCall = (callee: string, args: string[]) => {
  // Trailing empty optional arguments are dropped
  const kept = [...args];
  while (kept.length && (kept[kept.length - 1] === '' || kept[kept.length - 1] === 'null')) kept.pop();
  return `${callee}(${kept.join(', ')})`;
};

/** A string literal of the language */
export const quote = (text: string) => JSON.stringify(text);
export function unquote(literal: string | undefined): string | null {
  if (!literal || !literal.startsWith('"')) return null;
  try {
    return JSON.parse(literal) as string;
  } catch {
    return null;
  }
}

/** Names an expression refers to (not callees, members, object keys, builtins, keywords nor text in strings) */
export function references(expr: string): string[] {
  // Strings emptied, then object keys taken out ({label: …, value: …}); a ternary's a ? b : c keeps b
  const bare = expr.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/([{,]\s*)[A-Za-z_]\w*\s*:/g, '$1');
  const names = new Set<string>();
  const re = /(^|[^.\w@$])(\$?[A-Za-z_]\w*)\b(?!\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) {
    if (!['true', 'false', 'null'].includes(m[2])) names.add(m[2]);
  }
  return [...names];
}

const byName = (statements: Statement[]) => new Map(statements.map(s => [s.name, s]));

/** Statements not reachable from root are dropped (state variables are kept) */
export function collectGarbage(statements: Statement[]): Statement[] {
  const map = byName(statements);
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || !map.has(name)) return;
    seen.add(name);
    references(map.get(name)!.expr).forEach(visit);
  };
  visit('root');
  return statements.filter(s => seen.has(s.name) || s.name.startsWith('$'));
}

const CONTAINERS = new Set(['Dashboard', 'Row', 'Filters']);

/** The container holding a block: its statement and the block's position in its list */
export function parentOf(statements: Statement[], id: string): { parent: Statement; list: string[]; index: number } | null {
  for (const s of statements) {
    const call = parseCall(s.expr);
    if (!call || !CONTAINERS.has(call.callee)) continue;
    const listText = call.args[0] ?? '';
    if (!listText.startsWith('[')) continue;
    const list = splitTopLevel(listText.slice(1, -1)).filter(Boolean);
    const index = list.indexOf(id);
    if (index >= 0) return { parent: s, list, index };
  }
  return null;
}

function setList(parent: Statement, list: string[]): void {
  const call = parseCall(parent.expr)!;
  call.args[0] = `[${list.join(', ')}]`;
  parent.expr = `${call.callee}(${call.args.join(', ')})`;
}

/** A block one place earlier (-1) or later (+1) in its container */
export function moveBlock(program: string, id: string, delta: -1 | 1): string {
  const statements = parseStatements(program);
  const found = parentOf(statements, id);
  if (!found) return program;
  const to = found.index + delta;
  if (to < 0 || to >= found.list.length) return program;
  const list = [...found.list];
  [list[found.index], list[to]] = [list[to], list[found.index]];
  setList(found.parent, list);
  return serialize(statements);
}

/** A block out of the dashboard, with what only it used (its queries included) */
export function removeBlock(program: string, id: string): string {
  const statements = parseStatements(program);
  const found = parentOf(statements, id);
  if (!found) return program;
  setList(found.parent, found.list.filter(n => n !== id));
  return serialize(collectGarbage(statements));
}

/** A copy of a block right after it (same queries); returns the program and the copy's name */
export function duplicateBlock(program: string, id: string): { program: string; id: string } {
  const statements = parseStatements(program);
  const source = statements.find(s => s.name === id);
  const found = parentOf(statements, id);
  if (!source || !found) return { program, id };
  const names = new Set(statements.map(s => s.name));
  let n = 2;
  while (names.has(`${id}${n}`)) n++;
  const copy = { name: `${id}${n}`, expr: source.expr };
  statements.splice(statements.indexOf(source) + 1, 0, copy);
  const list = [...found.list];
  list.splice(found.index + 1, 0, copy.name);
  setList(found.parent, list);
  return { program: serialize(statements), id: copy.name };
}

/** Position of the title among the arguments, for the blocks that have one */
const TITLE_ARG: Record<string, number> = {
  Heading: 0, BarChart: 2, LineChart: 2, AreaChart: 2, DonutChart: 2, MultiLineChart: 2, MultiBarChart: 2, StackedBarChart: 2,
  Table: 2, Heatmap: 2, Progress: 0, Record: 2,
};

export function blockType(program: string, id: string): string | null {
  const s = parseStatements(program).find(x => x.name === id);
  return s ? parseCall(s.expr)?.callee ?? null : null;
}

export function blockTitle(program: string, id: string): string | null {
  const s = parseStatements(program).find(x => x.name === id);
  const call = s ? parseCall(s.expr) : null;
  if (!call || TITLE_ARG[call.callee] === undefined) return null;
  return unquote(call.args[TITLE_ARG[call.callee]]) ?? '';
}

export function setBlockTitle(program: string, id: string, title: string): string {
  const statements = parseStatements(program);
  const s = statements.find(x => x.name === id);
  const call = s ? parseCall(s.expr) : null;
  if (!s || !call || TITLE_ARG[call.callee] === undefined) return program;
  const at = TITLE_ARG[call.callee];
  while (call.args.length < at) call.args.push('null');
  call.args[at] = quote(title);
  s.expr = formatCall(call.callee, call.args);
  return serialize(statements);
}

const SINGLE = ['BarChart', 'LineChart', 'AreaChart', 'DonutChart'];
const MULTI = ['MultiLineChart', 'MultiBarChart', 'StackedBarChart'];

/** The types a block can switch to without the AI (same data, another look) */
export function typeChoices(program: string, id: string): string[] {
  const s = parseStatements(program).find(x => x.name === id);
  const call = s ? parseCall(s.expr) : null;
  if (!call) return [];
  if (SINGLE.includes(call.callee)) {
    const table = /^(\w+)\.rows\.\w+$/.test(call.args[0] ?? '') ? ['Table'] : [];
    return [...SINGLE, ...table].filter(t => t !== call.callee);
  }
  if (MULTI.includes(call.callee)) return MULTI.filter(t => t !== call.callee);
  return [];
}

export function changeType(program: string, id: string, type: string): string {
  if (!typeChoices(program, id).includes(type)) return program;
  const statements = parseStatements(program);
  const s = statements.find(x => x.name === id)!;
  const call = parseCall(s.expr)!;
  if (type === 'Table') {
    const query = /^(\w+)\.rows\./.exec(call.args[0])![1];
    s.expr = formatCall('Table', [`${query}.columns`, `${query}.rows`, call.args[2] ?? 'null']);
  } else {
    s.expr = formatCall(type, call.args);
  }
  return serialize(statements);
}

const isQuery = (s: Statement | undefined) => !!s && /^Query\(/.test(s.expr.trim());

/** The queries a block reads, through the statements it uses */
export function blockQueries(program: string, id: string): string[] {
  const map = byName(parseStatements(program));
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const s = map.get(name);
    if (!s) return;
    if (isQuery(s)) {
      out.add(name);
      return;
    }
    references(s.expr).forEach(visit);
  };
  visit(id);
  return [...out];
}

/** The SQL of a Query("sql", {query: "…"}) statement */
export function querySql(program: string, name: string): string | null {
  const s = parseStatements(program).find(x => x.name === name);
  if (!isQuery(s)) return null;
  const m = /\{\s*query\s*:\s*("(?:\\.|[^"\\])*")/.exec(s!.expr);
  return m ? unquote(m[1]) : null;
}

export function setQuerySql(program: string, name: string, sql: string): string {
  const statements = parseStatements(program);
  const s = statements.find(x => x.name === name);
  if (!isQuery(s)) return program;
  s!.expr = s!.expr.replace(/(\{\s*query\s*:\s*)"(?:\\.|[^"\\])*"/, (_m, head: string) => `${head}${quote(sql.trim())}`);
  return serialize(statements);
}

/** The headers a Table or Record shows (its labels argument), if any */
export function blockLabels(program: string, id: string): string[] | null {
  const s = parseStatements(program).find(x => x.name === id);
  const call = s ? parseCall(s.expr) : null;
  if (!call || !['Table', 'Record'].includes(call.callee) || !call.args[3]?.startsWith('[')) return null;
  try {
    const labels = JSON.parse(call.args[3]) as unknown;
    return Array.isArray(labels) && labels.every(l => typeof l === 'string') ? labels as string[] : null;
  } catch {
    return null;
  }
}

/** Whether a container (a Row…) holds a block, at any depth */
function contains(statements: Statement[], containerId: string, id: string): boolean {
  const s = statements.find(x => x.name === containerId);
  const call = s ? parseCall(s.expr) : null;
  if (!call || !CONTAINERS.has(call.callee) || !call.args[0]?.startsWith('[')) return false;
  const list = splitTopLevel(call.args[0].slice(1, -1)).filter(Boolean);
  return list.includes(id) || list.some(child => contains(statements, child, id));
}

/**
 * A block dropped before or after another one, in that one's container (a row or the
 * dashboard): it may change container. A row left empty goes away.
 */
export function moveBlockTo(program: string, id: string, targetId: string, side: 'before' | 'after'): string {
  if (id === targetId) return program;
  const statements = parseStatements(program);
  const from = parentOf(statements, id);
  const to = parentOf(statements, targetId);
  if (!from || !to || contains(statements, id, targetId)) return program;
  setList(from.parent, from.list.filter(n => n !== id));
  const target = parentOf(statements, targetId)!;
  const list = target.list.filter(n => n !== id);
  list.splice(list.indexOf(targetId) + (side === 'after' ? 1 : 0), 0, id);
  setList(target.parent, list);
  // A container emptied by the move (a row) is taken out of its own container
  const left = from.parent;
  const leftCall = parseCall(left.expr);
  if (left.name !== 'root' && leftCall && leftCall.callee === 'Row' && leftCall.args[0] === '[]') {
    const holder = parentOf(statements, left.name);
    if (holder) setList(holder.parent, holder.list.filter(n => n !== left.name));
    return serialize(collectGarbage(statements));
  }
  return serialize(statements);
}

/** The figures of a Kpis block (its items), as written */
export function kpiItems(program: string, id: string): string[] {
  const s = parseStatements(program).find(x => x.name === id);
  const call = s ? parseCall(s.expr) : null;
  if (!call || call.callee !== 'Kpis' || !call.args[0]?.startsWith('[')) return [];
  return splitTopLevel(call.args[0].slice(1, -1)).filter(Boolean);
}

/**
 * A block of several figures split into one card per figure, side by side in a row that keeps
 * the block's name (and so its place and size): each card can then be moved and resized.
 */
export function splitKpis(program: string, id: string): { program: string; ids: string[] } {
  const items = kpiItems(program, id);
  if (items.length < 2) return { program, ids: [] };
  const statements = parseStatements(program);
  const index = statements.findIndex(x => x.name === id);
  const names = new Set(statements.map(x => x.name));
  const ids: string[] = [];
  for (let n = 1; ids.length < items.length; n++) {
    if (!names.has(`${id}${n}`)) ids.push(`${id}${n}`);
  }
  statements[index] = { name: id, expr: `Row([${ids.join(', ')}])` };
  statements.splice(index + 1, 0, ...ids.map((name, i) => ({ name, expr: `Kpis([${items[i]}])` })));
  return { program: serialize(statements), ids };
}
