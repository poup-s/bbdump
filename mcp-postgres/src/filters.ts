import pgFormat from 'pg-format';

export interface Filter {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is_null' | 'is_not_null' | 'in' | 'between';
  value?: string | number | boolean | (string | number | boolean)[];
}

const OPERATOR_MAP: Record<string, string> = {
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
  in: 'IN',
  between: 'BETWEEN',
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
    } else if (filter.operator === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw new Error(`Filter on column "${filter.column}" with operator "in" requires a non-empty array value`);
      }
      const placeholders = filter.value.map((_: any) => `$${paramIndex++}`);
      conditions.push(`${col} IN (${placeholders.join(', ')})`);
      params.push(...filter.value);
    } else if (filter.operator === 'between') {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        throw new Error(`Filter on column "${filter.column}" with operator "between" requires an array of exactly 2 values`);
      }
      conditions.push(`${col} BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
      params.push(filter.value[0], filter.value[1]);
      paramIndex += 2;
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
