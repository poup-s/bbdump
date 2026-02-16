import pgFormat from 'pg-format';

export interface Filter {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is_null' | 'is_not_null';
  value?: string | number | boolean;
}

const OPERATOR_MAP: Record<Filter['operator'], string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
};

/**
 * Build a parameterized WHERE clause from structured filters.
 * Uses pg-format for identifier escaping and $N placeholders for values.
 *
 * @param filters Array of filter conditions
 * @param paramOffset Starting parameter index (e.g., 1 for $1)
 * @returns { clause: string, params: any[] } — clause includes "WHERE" prefix
 */
export function buildWhereClause(
  filters: Filter[],
  paramOffset: number = 1
): { clause: string; params: any[] } {
  if (filters.length === 0) {
    return { clause: '', params: [] };
  }

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = paramOffset;

  for (const filter of filters) {
    const sqlOp = OPERATOR_MAP[filter.operator];
    if (!sqlOp) {
      throw new Error(`Unknown filter operator: ${filter.operator}`);
    }

    const col = pgFormat('%I', filter.column);

    if (filter.operator === 'is_null' || filter.operator === 'is_not_null') {
      conditions.push(`${col} ${sqlOp}`);
    } else {
      if (filter.value === undefined || filter.value === null) {
        throw new Error(`Filter on column "${filter.column}" with operator "${filter.operator}" requires a value`);
      }
      conditions.push(`${col} ${sqlOp} $${paramIndex}`);
      params.push(filter.value);
      paramIndex++;
    }
  }

  return {
    clause: 'WHERE ' + conditions.join(' AND '),
    params,
  };
}
