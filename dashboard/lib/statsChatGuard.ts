const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|vacuum|call|do|pg_sleep|pg_terminate_backend|lock)\b/i;

/** Removes single-quoted string literals (including `''` escapes) so the checks
 * below can't be fooled by, or trip over, SQL that legitimately contains `--`
 * or a bracket inside a literal — `where name = 'Flors (Girona)'` is fine, and
 * `where note = '--'` is not a comment. Each literal becomes `''` so token
 * boundaries around it are preserved. */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** App-level first-pass filter on the SQL chat's run_sql tool (see
 * docs/superpowers/specs/2026-08-05-statistics-and-insights-design.md §3).
 *
 * This is a cheap filter, NOT the security boundary. The boundary is in the
 * database: supabase/migrations/2026-08-05-stats-reader-role.sql runs every
 * query as `stats_reader`, a NOLOGIN role holding select on exactly the 13
 * advertised tables and nothing else, inside a read-only transaction, with the
 * 500-row cap applied by a cursor rather than by wrapping the caller's text.
 * Nothing this function lets through can reach a table the chat isn't meant to
 * see. Treat a change here as ergonomics (a clearer error, sooner) and never as
 * the thing that keeps the sandbox closed.
 *
 * Pure and conservative: anything ambiguous is rejected rather than parsed
 * precisely. */
export function isReadOnlySelect(query: string): { ok: true; query: string } | { ok: false; reason: string } {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, reason: "empty query" };

  // Strip exactly one optional trailing semicolon; anything else containing a
  // semicolon is a stacked-statement attempt.
  const stripped = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (stripped.includes(";")) return { ok: false, reason: "multiple statements are not allowed" };

  if (!/^(select|with)\b/i.test(stripped)) {
    return { ok: false, reason: "query must start with SELECT or WITH" };
  }

  // Every check below runs against the literal-stripped form. A keyword inside
  // a quoted literal is data, not SQL — `where product_title = 'Create Your Own
  // Bouquet'` is an ordinary analytics query, and scanning the raw text for
  // \bcreate\b rejected it.
  const bare = stripStringLiterals(stripped);

  if (FORBIDDEN.test(bare)) {
    return { ok: false, reason: "query contains a disallowed keyword" };
  }

  // Belt and braces against the shape of the old cap bypass (close our
  // parentheses, comment out the tail). The cursor in stats_sandbox.fetch_capped
  // is what actually makes that impossible now, but generated analytics SQL
  // needs neither comments nor unbalanced brackets, so rejecting them costs
  // nothing and keeps obviously-malformed input from reaching the database.
  // Only the *openers* are checked: a block comment cannot exist without `/*`,
  // and testing for a bare `*/` would risk rejecting valid arithmetic for no
  // extra coverage.
  if (bare.includes("--") || bare.includes("/*")) {
    return { ok: false, reason: "SQL comments are not allowed" };
  }

  let depth = 0;
  for (const ch of bare) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) break;
  }
  if (depth !== 0) return { ok: false, reason: "unbalanced parentheses" };

  return { ok: true, query: stripped };
}
