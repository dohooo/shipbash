/**
 * The one row a statement must return. `rows[0]` after an `insert … returning`,
 * an `update … returning` or a keyed select is `Row | undefined` to the
 * compiler; the store treats "no row" as a broken invariant, and this names
 * the table and the statement instead of letting a mapper trip over undefined.
 */
export function expectRow<Row>(rows: readonly Row[], table: string, statement: string): Row {
  const row = rows[0];
  if (row === undefined) throw new Error(`${table}: ${statement} returned no row.`);
  return row;
}
