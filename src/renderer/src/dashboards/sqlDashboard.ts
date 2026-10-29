/**
 * Dashboards of MySQL / MariaDB, SQL Server, SQLite and DuckDB databases, what the AI is shown:
 * the tool a block's query uses (Query("mysql", …), Query("sqlserver", …), Query("sqlite", …),
 * Query("duckdb", …): the name says the dialect, so a dashboard
 * only goes on a database that reads it) and two example programs per dialect (pure: tested
 * without a window, their queries run on real servers in the tests).
 */

const tool = (name: 'mysql' | 'sqlite' | 'duckdb' | 'sqlserver', dialect: string) => ({
  name,
  description: `Runs one read-only SELECT (${dialect}) on the database and returns its columns and rows (rows are objects keyed by column alias). At most 1000 rows, 30 s. Filter placeholders {{from}}, {{to}} and {{name}} are bound by bbdump as ? parameters.`,
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'One SELECT statement' } }, required: ['query'] },
  outputSchema: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } } } },
  annotations: { readOnlyHint: true },
});

export const MYSQL_TOOL = tool('mysql', 'MySQL / MariaDB');
export const SQLITE_TOOL = tool('sqlite', 'SQLite');
export const DUCKDB_TOOL = tool('duckdb', 'DuckDB');
export const SQLSERVER_TOOL = tool('sqlserver', 'SQL Server');

/** Query("…", {query: "…"}) of an example: the SQL quoted for OpenUI */
const query = (name: string, sql: string) => `Query("${name}", {query: ${JSON.stringify(sql)}}, {columns: [], rows: []})`;

const LAYOUT = `filters = Filters([PeriodFilter("30d"), SelectFilter("city", "City", cities.rows.value)])
figures = Row([ordersKpi, revenueKpi])
ordersKpi = Kpis([{label: "Orders", value: @First(totals.rows.orders), format: "integer"}])
revenueKpi = Kpis([{label: "Revenue", value: @First(totals.rows.revenue), format: "money:EUR"}])
charts = Row([weekChart])
weekChart = StackedBarChart(perWeek.rows.week, [{label: "Paid", values: perWeek.rows.paid}, {label: "Cancelled", values: perWeek.rows.cancelled}], "Orders per week")
latest = Table(recent.columns, recent.rows, "Latest orders", ["Order", "Customer", "Status", "Total", "Date"], ["integer", "text", "text", "money:EUR", "datetime"])`;

const LINKED_LAYOUT = `filters = Filters([SearchFilter("q", "Search", "Name or email")])
people = Table(users.columns, users.rows, "Users (click one)", ["", "Name", "Email", "Signed up"], ["text", "text", "text", "date"], {filter: "user", column: "id", label: "email"})
profile = Record(picked.columns, picked.rows, "Picked user", ["Name", "Email", "Phone", "Signed up", "Orders"], ["text", "text", "text", "date", "integer"], "Click a user to see the details")
orders = Table(theirOrders.columns, theirOrders.rows, "Orders", ["Order", "Status", "Total", "Date"], ["integer", "text", "money:EUR", "datetime"])`;

// --- MySQL / MariaDB ------------------------------------------------------------------------------

const MYSQL_CITY = '({{city}} IS NULL OR c.city = {{city}})';
const MYSQL_PERIOD = 'o.created_at >= {{from}} AND o.created_at < {{to}}';

export const MYSQL_EXAMPLE = `root = Dashboard([filters, figures, charts, latest])
cities = ${query('mysql', 'SELECT DISTINCT city AS value FROM customers WHERE city IS NOT NULL ORDER BY 1 LIMIT 100')}
totals = ${query('mysql', `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${MYSQL_PERIOD} AND ${MYSQL_CITY}`)}
perWeek = ${query('mysql', `SELECT DATE(o.created_at - INTERVAL WEEKDAY(o.created_at) DAY) AS week, SUM(o.status = 'paid') AS paid, SUM(o.status = 'cancelled') AS cancelled FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${MYSQL_PERIOD} AND ${MYSQL_CITY} GROUP BY week ORDER BY week`)}
recent = ${query('mysql', `SELECT o.id, c.name, o.status, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${MYSQL_CITY} ORDER BY o.created_at DESC LIMIT 50`)}
${LAYOUT}`;

export const MYSQL_EXAMPLE_LINKED = `root = Dashboard([filters, people, profile, orders])
users = ${query('mysql', "SELECT u.id, u.name, u.email, u.created_at FROM users u WHERE ({{q}} IS NULL OR u.name LIKE CONCAT('%', {{q}}, '%') OR u.email LIKE CONCAT('%', {{q}}, '%')) ORDER BY u.created_at DESC LIMIT 50")}
picked = ${query('mysql', 'SELECT u.name, u.email, u.phone, u.created_at, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders FROM users u WHERE u.id = {{user}}')}
theirOrders = ${query('mysql', 'SELECT o.id, o.status, o.total, o.created_at FROM orders o WHERE ({{user}} IS NULL OR o.user_id = {{user}}) ORDER BY o.created_at DESC LIMIT 50')}
${LINKED_LAYOUT}`;

// --- SQLite ---------------------------------------------------------------------------------------

const SQLITE_CITY = '({{city}} IS NULL OR c.city = {{city}})';
// Dates stored as text ("2026-10-28 09:30:00", ISO 8601) compare as text with the bound bounds
const SQLITE_PERIOD = 'o.created_at >= {{from}} AND o.created_at < {{to}}';

export const SQLITE_EXAMPLE = `root = Dashboard([filters, figures, charts, latest])
cities = ${query('sqlite', 'SELECT DISTINCT city AS value FROM customers WHERE city IS NOT NULL ORDER BY 1 LIMIT 100')}
totals = ${query('sqlite', `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${SQLITE_PERIOD} AND ${SQLITE_CITY}`)}
perWeek = ${query('sqlite', `SELECT date(o.created_at, 'weekday 0', '-6 days') AS week, SUM(o.status = 'paid') AS paid, SUM(o.status = 'cancelled') AS cancelled FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${SQLITE_PERIOD} AND ${SQLITE_CITY} GROUP BY week ORDER BY week`)}
recent = ${query('sqlite', `SELECT o.id, c.name, o.status, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${SQLITE_CITY} ORDER BY o.created_at DESC LIMIT 50`)}
${LAYOUT}`;

export const SQLITE_EXAMPLE_LINKED = `root = Dashboard([filters, people, profile, orders])
users = ${query('sqlite', "SELECT u.id, u.name, u.email, u.created_at FROM users u WHERE ({{q}} IS NULL OR u.name LIKE '%' || {{q}} || '%' OR u.email LIKE '%' || {{q}} || '%') ORDER BY u.created_at DESC LIMIT 50")}
picked = ${query('sqlite', 'SELECT u.name, u.email, u.phone, u.created_at, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders FROM users u WHERE u.id = {{user}}')}
theirOrders = ${query('sqlite', 'SELECT o.id, o.status, o.total, o.created_at FROM orders o WHERE ({{user}} IS NULL OR o.user_id = {{user}}) ORDER BY o.created_at DESC LIMIT 50')}
${LINKED_LAYOUT}`;

// --- DuckDB ---------------------------------------------------------------------------------------

const DUCKDB_CITY = '({{city}} IS NULL OR c.city = {{city}})';
// The bound date texts are read as timestamps
const DUCKDB_PERIOD = 'o.created_at >= {{from}} AND o.created_at < {{to}}';

export const DUCKDB_EXAMPLE = `root = Dashboard([filters, figures, charts, latest])
cities = ${query('duckdb', 'SELECT DISTINCT city AS value FROM customers WHERE city IS NOT NULL ORDER BY 1 LIMIT 100')}
totals = ${query('duckdb', `SELECT count(*) AS orders, coalesce(sum(o.total), 0) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${DUCKDB_PERIOD} AND ${DUCKDB_CITY}`)}
perWeek = ${query('duckdb', `SELECT CAST(date_trunc('week', o.created_at) AS DATE) AS week, count(*) FILTER (WHERE o.status = 'paid') AS paid, count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${DUCKDB_PERIOD} AND ${DUCKDB_CITY} GROUP BY week ORDER BY week`)}
recent = ${query('duckdb', `SELECT o.id, c.name, o.status, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${DUCKDB_CITY} ORDER BY o.created_at DESC LIMIT 50`)}
${LAYOUT}`;

export const DUCKDB_EXAMPLE_LINKED = `root = Dashboard([filters, people, profile, orders])
users = ${query('duckdb', "SELECT u.id, u.name, u.email, u.created_at FROM users u WHERE ({{q}} IS NULL OR u.name ILIKE '%' || {{q}} || '%' OR u.email ILIKE '%' || {{q}} || '%') ORDER BY u.created_at DESC LIMIT 50")}
picked = ${query('duckdb', 'SELECT u.name, u.email, u.phone, u.created_at, (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS orders FROM users u WHERE u.id = {{user}}')}
theirOrders = ${query('duckdb', 'SELECT o.id, o.status, o.total, o.created_at FROM orders o WHERE ({{user}} IS NULL OR o.user_id = {{user}}) ORDER BY o.created_at DESC LIMIT 50')}
${LINKED_LAYOUT}`;

// --- SQL Server -----------------------------------------------------------------------------------

const SQLSERVER_CITY = '({{city}} IS NULL OR c.city = {{city}})';
// The bound date texts as datetime2: they compare with datetime columns too (which start in 1753)
const SQLSERVER_PERIOD = 'o.created_at >= CAST({{from}} AS datetime2) AND o.created_at < CAST({{to}} AS datetime2)';
// Monday of the week, as text (1900-01-01 was a Monday): whatever the server's DATEFIRST
const SQLSERVER_WEEK = "CONVERT(char(10), DATEADD(day, -(DATEDIFF(day, '19000101', o.created_at) % 7), CAST(o.created_at AS date)), 23)";

export const SQLSERVER_EXAMPLE = `root = Dashboard([filters, figures, charts, latest])
cities = ${query('sqlserver', 'SELECT DISTINCT TOP (100) city AS value FROM customers WHERE city IS NOT NULL ORDER BY value')}
totals = ${query('sqlserver', `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${SQLSERVER_PERIOD} AND ${SQLSERVER_CITY}`)}
perWeek = ${query('sqlserver', `SELECT ${SQLSERVER_WEEK} AS week, SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${SQLSERVER_PERIOD} AND ${SQLSERVER_CITY} GROUP BY ${SQLSERVER_WEEK} ORDER BY week`)}
recent = ${query('sqlserver', `SELECT TOP (50) o.id, c.name, o.status, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${SQLSERVER_CITY} ORDER BY o.created_at DESC`)}
${LAYOUT}`;

export const SQLSERVER_EXAMPLE_LINKED = `root = Dashboard([filters, people, profile, orders])
users = ${query('sqlserver', "SELECT TOP (50) u.id, u.name, u.email, u.created_at FROM users u WHERE ({{q}} IS NULL OR u.name LIKE '%' + {{q}} + '%' OR u.email LIKE '%' + {{q}} + '%') ORDER BY u.created_at DESC")}
picked = ${query('sqlserver', 'SELECT u.name, u.email, u.phone, u.created_at, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders FROM users u WHERE u.id = {{user}}')}
theirOrders = ${query('sqlserver', 'SELECT TOP (50) o.id, o.status, o.total, o.created_at FROM orders o WHERE ({{user}} IS NULL OR o.user_id = {{user}}) ORDER BY o.created_at DESC')}
${LINKED_LAYOUT}`;
