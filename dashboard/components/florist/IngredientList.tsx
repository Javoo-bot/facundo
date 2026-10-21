/** Splits a bouquet_spec string into individual ingredient lines. Two shapes
 * in the wild: mock/seed data is one comma-separated line ("Pink roses x8,
 * White lilies x4"); Shopify's real `custom.recipe` variant metafield is
 * newline-separated ("12 Freedom rose 50cm\n2 White limonium\n..."). Split on
 * newline when present (real data), else fall back to comma (mock data).
 * Trims whitespace and drops empties either way. */
export function parseIngredients(spec: string | null | undefined): string[] {
  if (!spec) return [];
  return spec
    .split(spec.includes("\n") ? "\n" : ",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Renders a bouquet's ingredients one per line (small stacked/bulleted
 * list) instead of the old inline comma string. Renders nothing when the
 * spec is null/empty — never a broken/empty list. */
/** Splits an ingredient line into its name and a trailing quantity, tolerating
 * "Pink roses x8", "Pink roses × 8", "8x Pink roses" (mock/seed data) as well
 * as Shopify's real recipe format, a bare leading count with no x/× separator
 * ("12 Freedom rose 50cm" → qty 12, name "Freedom rose 50cm" — checked last so
 * it can't swallow a mid-string size token like the "50cm" here, which has no
 * space before it). Returns qty null for lines with no count (e.g. "White Vase"
 * or a "~45 cm" size note). */
export function splitQuantity(line: string): { name: string; qty: string | null } {
  const trailing = line.match(/^(.*?)\s*[x×]\s*(\d+)\s*$/i);
  if (trailing) return { name: trailing[1].trim(), qty: trailing[2] };
  const leadingX = line.match(/^(\d+)\s*[x×]\s*(.+)$/i);
  if (leadingX) return { name: leadingX[2].trim(), qty: leadingX[1] };
  const bareLeading = line.match(/^(\d+)\s+(.+)$/);
  if (bareLeading) return { name: bareLeading[2].trim(), qty: bareLeading[1] };
  return { name: line, qty: null };
}

export default function IngredientList({ spec }: { spec: string | null | undefined }) {
  const lines = parseIngredients(spec);
  if (lines.length === 0) return null;
  return (
    <div className="spec-list">
      {lines.map((line, i) => {
        const { name, qty } = splitQuantity(line);
        return (
          <div key={i} className="recipe-row">
            <span>{name}</span>
            {qty && <span className="recipe-qty">× {qty}</span>}
          </div>
        );
      })}
    </div>
  );
}
