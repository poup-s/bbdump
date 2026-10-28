/**
 * Dashboards of MongoDB databases, what the AI is shown: the tool a block's query uses and two
 * example programs (pure: tested without a window, their pipelines run on a real server).
 */

/** MongoDB databases: a dashboard's queries are read-only aggregations run by bbdump */
export const MONGO_TOOL = {
  name: 'mongo',
  description: 'Runs one read-only aggregation on a MongoDB collection and returns its columns (the top-level fields) and rows. The query is a JSON text: {"collection": "orders", "pipeline": [...]}. At most 1000 rows, 30 s. Filter placeholders "{{from}}", "{{to}}" and "{{name}}" are replaced by bbdump with values.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'JSON text {"collection": …, "pipeline": […]}' } }, required: ['query'] },
  outputSchema: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } } } },
  annotations: { readOnlyHint: true },
};

/** Query("mongo", …) of an example: the pipeline written as JSON, quoted for OpenUI */
const mongoQuery = (collection: string, pipeline: unknown[]) => `Query("mongo", {query: ${JSON.stringify(JSON.stringify({ collection, pipeline }))}}, {columns: [], rows: []})`;
const cityIs = (field: string) => ({ $expr: { $or: [{ $eq: ['{{city}}', null] }, { $eq: [field, '{{city}}'] }] } });
const inPeriod = { created_at: { $gte: '{{from}}', $lt: '{{to}}' } };

export const MONGO_EXAMPLE = `root = Dashboard([filters, figures, charts, latest])
cities = ${mongoQuery('orders', [{ $group: { _id: '$customer.city' } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }, { $limit: 100 }, { $project: { _id: 0, value: '$_id' } }])}
totals = ${mongoQuery('orders', [{ $match: { ...inPeriod, ...cityIs('$customer.city') } }, { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total' } } }, { $project: { _id: 0, orders: '$orders', revenue: '$revenue' } }])}
perWeek = ${mongoQuery('orders', [{ $match: { ...inPeriod, ...cityIs('$customer.city') } }, { $group: { _id: { $dateTrunc: { date: '$created_at', unit: 'week' } }, paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } }, cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } } } }, { $sort: { _id: 1 } }, { $project: { _id: 0, week: '$_id', paid: '$paid', cancelled: '$cancelled' } }])}
recent = ${mongoQuery('orders', [{ $match: cityIs('$customer.city') }, { $sort: { created_at: -1 } }, { $limit: 50 }, { $project: { _id: 0, id: { $toString: '$_id' }, name: '$customer.name', status: '$status', total: '$total', created_at: '$created_at' } }])}
filters = Filters([PeriodFilter("30d"), SelectFilter("city", "City", cities.rows.value)])
figures = Row([ordersKpi, revenueKpi])
ordersKpi = Kpis([{label: "Orders", value: @First(totals.rows.orders), format: "integer"}])
revenueKpi = Kpis([{label: "Revenue", value: @First(totals.rows.revenue), format: "money:EUR"}])
charts = Row([weekChart])
weekChart = StackedBarChart(perWeek.rows.week, [{label: "Paid", values: perWeek.rows.paid}, {label: "Cancelled", values: perWeek.rows.cancelled}], "Orders per week")
latest = Table(recent.columns, recent.rows, "Latest orders", ["", "Customer", "Status", "Total", "Date"], ["text", "text", "text", "money:EUR", "datetime"])`;

const userIs = (expression: unknown) => ({ $expr: { $or: [{ $eq: ['{{user}}', null] }, { $eq: [expression, '{{user}}'] }] } });
export const MONGO_EXAMPLE_LINKED = `root = Dashboard([filters, people, profile, orders])
users = ${mongoQuery('users', [{ $match: { $or: [{ name: { $regex: '(?i){{q}}' } }, { email: { $regex: '(?i){{q}}' } }] } }, { $sort: { created_at: -1 } }, { $limit: 50 }, { $project: { _id: 0, id: { $toString: '$_id' }, name: '$name', email: '$email', created_at: '$created_at' } }])}
picked = ${mongoQuery('users', [{ $match: { $expr: { $eq: [{ $toString: '$_id' }, '{{user}}'] } } }, { $lookup: { from: 'orders', localField: '_id', foreignField: 'user_id', as: 'their' } }, { $project: { _id: 0, name: '$name', email: '$email', phone: '$phone', created_at: '$created_at', orders: { $size: '$their' } } }])}
theirOrders = ${mongoQuery('orders', [{ $match: userIs({ $toString: '$user_id' }) }, { $sort: { created_at: -1 } }, { $limit: 50 }, { $project: { _id: 0, id: { $toString: '$_id' }, status: '$status', total: '$total', created_at: '$created_at' } }])}
filters = Filters([SearchFilter("q", "Search", "Name or email")])
people = Table(users.columns, users.rows, "Users (click one)", ["", "Name", "Email", "Signed up"], ["text", "text", "text", "date"], {filter: "user", column: "id", label: "email"})
profile = Record(picked.columns, picked.rows, "Picked user", ["Name", "Email", "Phone", "Signed up", "Orders"], ["text", "text", "text", "date", "integer"], "Click a user to see the details")
orders = Table(theirOrders.columns, theirOrders.rows, "Orders", ["", "Status", "Total", "Date"], ["text", "text", "money:EUR", "datetime"])`;
