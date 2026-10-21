// A generic, in-memory, table-based stand-in for a Supabase/PostgREST client.
//
// WHY THIS EXISTS: the existing test pattern in this repo (see reconcile.test.ts,
// reconcileOrders.test.ts) hand-rolls a bespoke chainable stub PER TEST FILE,
// switching on which table/column was queried. That's fine for one function
// under test. orderLoop.e2e.test.ts drives a whole chain of real modules
// (parseShopifyOrder -> upsertOrder -> isInWorkingSet -> matchAndWriteCandidates
// -> matchFlorists -> insertCandidates, ...) that between them touch orders,
// order_line_items, order_events, order_assignments, florists, app_settings and
// ingest_jobs — a bespoke per-query stub for all of that would be bigger and
// more fragile than one small generic query-builder.
//
// This is NOT a Postgres. It has no real SQL, no transactions, no constraints,
// no joins/embeds (a `select("a, b(c)")` just returns the row as stored — an
// embed only "works" if the caller already put a nested object there). It
// implements exactly the PostgREST surface the driven modules use: .from(),
// .select/.insert/.update/.upsert/.delete, .eq/.neq/.in/.is/.not/.gte/.lte/.gt/
// .lt/.ilike, .order/.limit, .single/.maybeSingle, and — because supabase-js
// query builders are THENABLE, not real Promises — a bare `await` on a chain
// with no terminal call (e.g. `await sb.from("orders").update(x).eq("id", y)`,
// used throughout db.ts) also works.
//
// SQL NULL semantics: a row built from a plain JS object literal simply lacks
// a key for a column nobody set (e.g. `deleted_at`), where a real Postgres row
// always has the column, defaulting to NULL. `.is(col, null)` (and its
// negation via `.not(col, "is", null)`) treat a missing key the same as an
// explicit `null` for exactly this reason — see `matchOne` below.

export type Row = Record<string, unknown>;

interface Filter {
  col: string;
  op: "eq" | "neq" | "in" | "is" | "gte" | "lte" | "gt" | "lt" | "ilike" | "not";
  val: unknown;
  innerOp?: Filter["op"];
}

function ilikeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${withWildcards}$`, "i");
}

function matchOne(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case "eq":
      return v === f.val;
    case "neq":
      return v !== f.val;
    case "in":
      return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
    case "is":
      // NULL-safe: an absent key IS NULL, same as a real Postgres column
      // nobody wrote to. Only meaningful for null/true/false, per PostgREST.
      return f.val === null ? v == null : v === f.val;
    case "gte":
      return v != null && (v as number | string) >= (f.val as number | string);
    case "lte":
      return v != null && (v as number | string) <= (f.val as number | string);
    case "gt":
      return v != null && (v as number | string) > (f.val as number | string);
    case "lt":
      return v != null && (v as number | string) < (f.val as number | string);
    case "ilike":
      return v != null && ilikeToRegex(String(f.val)).test(String(v));
    case "not":
      return !matchOne(row, { col: f.col, op: f.innerOp as Filter["op"], val: f.val });
    default:
      return true;
  }
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) => filters.every((f) => matchOne(r, f)));
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const av = a as number | string;
  const bv = b as number | string;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

type Op = "select" | "insert" | "update" | "upsert" | "delete" | null;

class FakeQueryBuilder {
  private op: Op = null;
  private filters: Filter[] = [];
  private payload: Row[] | Row | null = null;
  private onConflict: string | null = null;
  private returning = false;
  private singleMode: "single" | "maybeSingle" | null = null;
  private orderSpec: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private selectOpts: { count?: "exact"; head?: boolean } | null = null;

  constructor(
    private readonly table: string,
    private readonly rows: () => Row[],
  ) {}

  select(_cols?: string, opts?: { count?: "exact"; head?: boolean }): this {
    if (this.op == null) this.op = "select";
    this.returning = true;
    this.selectOpts = opts ?? null;
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = payload;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ col, op: "neq", val });
    return this;
  }
  in(col: string, val: unknown[]): this {
    this.filters.push({ col, op: "in", val });
    return this;
  }
  is(col: string, val: unknown): this {
    this.filters.push({ col, op: "is", val });
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push({ col, op: "gte", val });
    return this;
  }
  lte(col: string, val: unknown): this {
    this.filters.push({ col, op: "lte", val });
    return this;
  }
  gt(col: string, val: unknown): this {
    this.filters.push({ col, op: "gt", val });
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push({ col, op: "lt", val });
    return this;
  }
  ilike(col: string, val: unknown): this {
    this.filters.push({ col, op: "ilike", val });
    return this;
  }
  not(col: string, innerOp: string, val: unknown): this {
    this.filters.push({ col, op: "not", innerOp: innerOp as Filter["op"], val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderSpec = { col, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): Promise<{ data: Row | null; error: { message: string; code?: string } | null }> {
    this.singleMode = "single";
    return this.execute() as never;
  }
  maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    this.singleMode = "maybeSingle";
    return this.execute() as never;
  }
  // Thenable, exactly like the real supabase-js builder — `await` alone (no
  // .single()/.maybeSingle()) is the common shape for a plain update/insert.
  then<T1 = unknown, T2 = never>(
    onFulfilled?: ((value: never) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.execute().then(onFulfilled as never, onRejected as never);
  }

  private async execute(): Promise<{ data: unknown; error: unknown; count?: number }> {
    const table = this.rows();
    let matched: Row[];

    switch (this.op) {
      case "select": {
        matched = applyFilters(table, this.filters);
        break;
      }
      case "insert": {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        matched = items.map((item) => {
          const row: Row = { id: item.id ?? genId(), ...item };
          table.push(row);
          return row;
        });
        break;
      }
      case "update": {
        matched = applyFilters(table, this.filters);
        for (const row of matched) Object.assign(row, this.payload as Row);
        break;
      }
      case "upsert": {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        matched = items.map((item) => {
          const existing = this.onConflict ? table.find((r) => r[this.onConflict!] === item[this.onConflict!]) : undefined;
          if (existing) {
            Object.assign(existing, item);
            return existing;
          }
          const row: Row = { id: item.id ?? genId(), ...item };
          table.push(row);
          return row;
        });
        break;
      }
      case "delete": {
        matched = applyFilters(table, this.filters);
        for (const row of matched) {
          const i = table.indexOf(row);
          if (i >= 0) table.splice(i, 1);
        }
        break;
      }
      default:
        matched = [];
    }

    if (this.op === "select" && this.orderSpec) {
      const { col, ascending } = this.orderSpec;
      matched = [...matched].sort((a, b) => cmp(a[col], b[col]) * (ascending ? 1 : -1));
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);

    if (this.singleMode === "single") {
      if (matched.length !== 1) {
        return { data: null, error: { message: `expected exactly 1 row for ${this.table}, got ${matched.length}`, code: "PGRST116" } };
      }
      return { data: matched[0], error: null };
    }
    if (this.singleMode === "maybeSingle") {
      if (matched.length > 1) return { data: null, error: { message: `expected 0 or 1 rows for ${this.table}, got ${matched.length}` } };
      return { data: matched[0] ?? null, error: null };
    }
    if (this.selectOpts?.head) return { data: null, error: null, count: matched.length };

    const returning = this.op === "select" || this.returning;
    const count = this.selectOpts?.count ? matched.length : undefined;
    return { data: returning ? matched : null, error: null, count };
  }
}

let counter = 0;
function genId(): string {
  counter += 1;
  return `row_${counter}`;
}

export interface FakeDb {
  /** The object real code calls `.from(table)` on — pass this wherever a
   *  `SupabaseClient` is expected (the driven modules only use the subset of
   *  the interface implemented above, so a structural `as any` cast at the
   *  call site is expected and fine for a test double). */
  from(table: string): FakeQueryBuilder;
  /** Read-only escape hatch for assertions: the live rows for a table (same
   *  array reference the builder mutates), so a test can assert on real state
   *  transitions rather than on what a function claims to have done. */
  table(name: string): Row[];
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));

  function ensure(name: string): Row[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  return {
    from(name: string) {
      return new FakeQueryBuilder(name, () => ensure(name));
    },
    table(name: string) {
      return ensure(name);
    },
  };
}
