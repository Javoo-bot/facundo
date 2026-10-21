import "server-only";

/**
 * Page a PostgREST query until every row is fetched.
 *
 * WHY THIS EXISTS: PostgREST caps an unbounded `select()` at 1000 rows (its max
 * page size) and returns that truncated page **with no error**. So a query that
 * reads "every florist" silently degrades into "the first 1000 in whatever order
 * the query asked for", and the truncation is invisible at every layer above it.
 *
 * That is exactly how, with ~3.4k florists on file, `/florists` came to show a
 * single row (the roster is fetched `.order("name")`, so the page only ever saw
 * names up to "Ex…", and just one of the 12 `production` florists sorts that
 * early) and how the order page's "Add florist" picker lost everyone after that
 * same cut — including "Flors Demo" — since it filters client-side over
 * whatever this fetch returned.
 *
 * Pass a builder that applies `.range(from, to)` to your query. IMPORTANT:
 * paging is only correct over a TOTAL order, so the builder must end in a
 * unique tiebreak (`.order("id")`) — with a non-unique sort key alone, rows
 * tied across a page boundary can be duplicated or skipped.
 *
 * Returns the error alongside the rows so callers that render a distinct error
 * state (rather than an empty roster) keep doing so.
 */
export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const PAGE_SIZE = 1000;
  const rows: T[] = [];
  let from = 0;
  // Bounded loop (100 pages = up to 100k rows) so a persistent query error or
  // an unexpectedly huge table can't spin forever.
  for (let i = 0; i < 100; i++) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows, error: null };
}
