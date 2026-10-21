"use client";

import BouquetPhoto from "@/components/florist/BouquetPhoto";
import IngredientList from "@/components/florist/IngredientList";
import { useT } from "@/components/florist/LocaleProvider";
import { splitList } from "@/components/florist/orderFormat";
import { splitOfferItems } from "@/lib/offerItems";
import { describeLineItem } from "@/lib/lineItemKind";
import type { OrderLineItem } from "@/lib/types";

/** What to make, led by a large photo of the bouquet.
 *
 * The photo carries the brief because it is the one field we always have:
 * `image_url` was present on 1000/1000 production line items, while
 * `bouquet_spec` (the recipe) was present on only 226. So "no recipe" is the
 * normal case and gets a real sentence rather than an empty space — one that
 * also sets the standard the florist's own delivery photo is later judged
 * against. We do not invent a recipe we don't have.
 *
 * Which item heroes is decided by lib/offerItems.ts, not by array order:
 * `order_line_items` has no guaranteed sort, so an order whose wine row comes
 * back first must not hero the wine. */
export default function OfferItems({ items }: { items: OrderLineItem[] }) {
  const { t } = useT();
  const { hero, alsoInclude } = splitOfferItems(items);

  if (!hero) {
    return (
      <div className="ocard">
        <div className="fc-offer-h">{t("ui.offer.page.makeTitle")}</div>
        <div style={{ marginTop: 8, color: "var(--ink-faint)", fontSize: ".85rem" }}>
          {t("ui.orderDetail.detail.noItems")}
        </div>
      </div>
    );
  }

  const heroTitle = hero.title ?? t("ui.orderDetail.detail.itemFallback");
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="ocard" style={{ padding: 0, overflow: "hidden" }}>
        <div className="fc-offer-h" style={{ padding: "13px 13px 10px" }}>{t("ui.offer.page.makeTitle")}</div>
        {/* FULL photo, never cropped: the florist is being asked to reproduce
            this arrangement, so cutting the top off it defeats the point. The
            image keeps its own proportions (height:auto, no object-fit), and
            only the placeholder — which has no intrinsic size — gets a fixed
            box to occupy. */}
        <BouquetPhoto
          src={hero.image_url}
          alt={heroTitle}
          style={hero.image_url
            ? { width: "100%", height: "auto", objectFit: "contain", display: "block" }
            : { width: "100%", aspectRatio: "4 / 3", display: "flex" }}
        />
        <div style={{ display: "grid", gap: 8, padding: 13 }}>
          <b style={{ fontSize: "1rem" }}>
            {heroTitle}
            {hero.variant ? ` · ${hero.variant}` : ""}
            {hero.quantity > 1 ? ` ×${hero.quantity}` : ""}
          </b>
          {hero.personalization && (
            <div style={{ fontSize: ".85rem", color: "var(--ink-soft)" }}>{hero.personalization}</div>
          )}
          {hero.bouquet_spec ? (
            <div>
              <div className="fc-recipe-h">{t("ui.orderDetail.detail.recipe")}</div>
              <IngredientList spec={hero.bouquet_spec} />
            </div>
          ) : (
            <div style={{ fontSize: ".85rem", color: "var(--ink-soft)", lineHeight: 1.45 }}>
              {t("ui.offer.page.photoIsTheBrief")}
            </div>
          )}
          {hero.components && (
            <div>
              <div className="fc-recipe-h">{t("ui.orderDetail.detail.components")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {splitList(hero.components).map((c) => <span key={c} className="badge badge-neutral">{c}</span>)}
              </div>
            </div>
          )}
          {hero.addons && (
            <div>
              <div className="fc-recipe-h">{t("ui.orderDetail.detail.addons")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {splitList(hero.addons).map((a) => <span key={a} className="badge badge-neutral">{a}</span>)}
              </div>
            </div>
          )}
          {/* `variant_text` deliberately not rendered: it is customer-facing
              upsell copy ("Make your surprise even bigger by adding more stems
              to your bouquet"), not something the florist should act on. */}
        </div>
      </div>

      {/* Everything else in the box. ~24% of orders have one — usually a bottle
          of wine or a box of chocolates the customer paid for, which a
          bouquet-only page would silently drop. */}
      {alsoInclude.length > 0 && (
        <div className="ocard" style={{ padding: 0, overflow: "hidden" }}>
          <div className="fc-offer-h" style={{ padding: "13px 13px 4px" }}>{t("ui.offer.page.alsoInclude")}</div>
          {alsoInclude.map((it) => {
            // "Greeting card · I Love You" rather than a bare "I Love You" —
            // derived from the barcode (lib/lineItemKind.ts), and just the
            // title when we can't name the type with confidence. The KIND is
            // ours to word, so it comes from the catalog; the title is
            // Shopify's and was localised server-side (lib/translations).
            const title =
              describeLineItem(it.title, it.barcode, (kind) => t(`ui.orderDetail.detail.kind.${kind}`)) ||
              t("ui.orderDetail.detail.itemFallback");
            return (
              <div key={it.id} className="fc-line">
                <BouquetPhoto
                  src={it.image_url}
                  alt={title}
                  style={{ width: 48, height: 48, borderRadius: 10, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 3, alignContent: "center" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                    <b style={{ fontSize: ".95rem" }}>{title}{it.variant ? ` · ${it.variant}` : ""}</b>
                    {it.quantity > 1 && (
                      <span style={{ color: "var(--ink-faint)", fontSize: ".8rem", flexShrink: 0 }}>×{it.quantity}</span>
                    )}
                  </div>
                  {it.addons && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {splitList(it.addons).map((a) => <span key={a} className="badge badge-neutral">{a}</span>)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
