import { createServiceClient } from "@/lib/supabaseAdmin";
import { resolveFloristLocale, t, LOCALES } from "@/lib/i18n";
import { HOUR_DAYS, type HourDay } from "@/lib/businessHours";
import { floristTimeZone } from "@/lib/floristTime";
import { greetingKey } from "@/lib/floristGreeting";
import { dialCountries, splitPhone } from "@/lib/dialCodes";
import { countryToRegion } from "@/lib/phone";
import FloristAcceptForm from "@/components/florist/FloristAcceptForm";
import TimeGreeting from "@/components/florist/TimeGreeting";
import ProspectIdentify from "@/components/reachout/ProspectIdentify";

export const dynamic = "force-dynamic";

function Card({ locale, title, body, accent = false }: { locale: string; title: string; body: string; accent?: boolean }) {
  return (
    <main lang={locale} className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
      <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.2rem" }}>{title}</h1>
        <p style={{ color: accent ? "var(--accent)" : "var(--ink-soft)", fontSize: ".9rem" }}>{body}</p>
      </div>
    </main>
  );
}

export default async function AcceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { token } = await params;
  // An explicit choice from the language picker wins over everything. It is not
  // persisted until they submit: switching language to read the form is not the
  // same as telling us which language to write to them in.
  const { locale: chosen } = await searchParams;

  const admin = createServiceClient();
  const { data: florist, error: lookupError } = await admin
    .from("florists")
    .select(
      "id, city_id, name, address, lat, lng, owner_name, phone_web, phone_mobile, phone_maps, email, shop_story, business_hours, next_day_cutoff_hour, join_token_expires_at, joined_at, locale"
    )
    .eq("join_token", token)
    .maybeSingle();
  if (lookupError) console.error("florist/accept/[token]: token lookup failed", lookupError.message);

  if (!florist) {
    const locale = resolveFloristLocale({ locale: chosen });
    return <Card locale={locale} title={t(locale, "ui.accept.invalidTitle")} body={t(locale, "ui.accept.invalidBody")} />;
  }

  // The shop's country, loaded HERE rather than further down, because the
  // locale depends on it. `florists.locale` is null for anyone the ingest's
  // fill_null_locales never ran over — every hand-added partner, for a start —
  // and resolveFloristLocale falls back to the country-implied language only
  // when it is actually given the country. Without it a shop in Girona or
  // Bordeaux was handed this form in English.
  const { data: city } = florist.city_id
    ? await admin.from("cities").select("country").eq("id", florist.city_id).maybeSingle()
    : { data: null };

  const locale = resolveFloristLocale({ locale: chosen ?? florist.locale }, city?.country ?? null);

  const expired =
    !florist.joined_at &&
    !!florist.join_token_expires_at &&
    new Date(florist.join_token_expires_at).getTime() <= Date.now();

  if (expired) {
    return <Card locale={locale} title={t(locale, "ui.accept.expiredTitle")} body={t(locale, "ui.accept.expiredBody")} />;
  }
  // A florist who has already joined gets the FORM again, pre-filled, not a
  // dead end. Someone who mistyped their address or changed their mobile
  // previously had no way back in — their link simply stopped working and they
  // had to ask us to send another. The token is still the credential and still
  // expires; re-running it is editing your details, not joining twice.
  const rejoining = !!florist.joined_at;

  // Greet by the SHOP's clock, resolved offline from its coordinates. Null when
  // we have none — TimeGreeting then falls back to the browser's after mount.
  const serverGreeting = greetingKey(floristTimeZone(florist.lat, florist.lng));

  // The florist's own country pre-selects both phone dropdowns, so the common
  // case is "type your number" rather than "find your country first". Built on
  // the server: libphonenumber + the country-name table never reach the
  // browser (lib/dialCodes.ts).
  const region = countryToRegion(city?.country ?? null);
  const countries = dialCountries();

  const days = Object.fromEntries(
    HOUR_DAYS.map((day) => [day, t(locale, `ui.accept.days.${day}`)])
  ) as Record<HourDay, string>;

  return (
    <main lang={locale} className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
      {/* Joins the anonymous visit that arrived from the recruiting email onto
          the florist the token was minted for. Without it PostHog holds the
          send/open/click funnel and the landed/joined funnel under two
          different ids and they never meet — see ProspectIdentify. */}
      <ProspectIdentify floristId={florist.id} />
      <div className="card" style={{ maxWidth: 520, width: "100%", padding: "30px 26px" }}>
        <TimeGreeting
          serverKey={serverGreeting}
          greetings={{
            morning: t(locale, "ui.accept.greeting.morning"),
            afternoon: t(locale, "ui.accept.greeting.afternoon"),
            evening: t(locale, "ui.accept.greeting.evening"),
            night: t(locale, "ui.accept.greeting.night"),
          }}
          name={florist.owner_name}
          namedTemplate={t(locale, "ui.accept.greetingNamed")}
          // Was baked into the old JoinGreeting; passed explicitly now that the
          // component is shared with the offer page, which styles it as a
          // headline rather than an eyebrow.
          className="eyebrow"
          style={{ marginBottom: 10, letterSpacing: ".1em" }}
        />
        <h1 style={{ fontSize: "1.4rem", marginBottom: 10 }}>
          {t(locale, rejoining ? "ui.accept.updateTitle" : "ui.accept.title")}
        </h1>
        <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", lineHeight: 1.5, marginBottom: 10 }}>
          {t(locale, "ui.accept.subtitle")}
        </p>
        <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", lineHeight: 1.5, marginBottom: 22 }}>
          {t(locale, rejoining ? "ui.accept.updateIntro" : "ui.accept.introCheck")}
        </p>
        <FloristAcceptForm
          token={token}
          initial={{
            name: florist.name ?? "",
            owner_name: florist.owner_name ?? "",
            address: florist.address ?? "",
            // Both split into country + national so each field opens on the
            // right dial code. The shop's public line seeds from the scraped
            // columns; the mobile seeds from phone_mobile ONLY — pre-filling it
            // with a scraped landline would put a number the florist never
            // chose behind a label promising we'll text it.
            phone: splitPhone(florist.phone_web ?? florist.phone_maps, region),
            mobile: splitPhone(florist.phone_mobile, region),
            email: florist.email ?? "",
            shop_story: florist.shop_story ?? "",
            business_hours: (florist.business_hours as Record<string, unknown> | null) ?? null,
            next_day_cutoff_hour: florist.next_day_cutoff_hour,
          }}
          countries={countries}
          locale={locale}
          localeOptions={LOCALES.map((l) => ({ code: l, label: t(locale, `ui.account.language.${l}`) }))}
          labels={{
            localeLabel: t(locale, "ui.account.language.title"),
            labelOwner: t(locale, "ui.accept.labelOwner"),
            labelName: t(locale, "ui.accept.labelName"),
            labelPhone: t(locale, "ui.accept.labelPhone"),
            labelMobile: t(locale, "ui.accept.labelMobile"),
            mobileHelper: t(locale, "ui.accept.mobileHelper"),
            mobileInvalid: t(locale, "ui.accept.mobileInvalid"),
            optional: t(locale, "ui.accept.optional"),
            countryLabel: t(locale, "ui.accept.countryLabel"),
            labelEmail: t(locale, "ui.accept.labelEmail"),
            storyTitle: t(locale, "ui.accept.storyTitle"),
            storyHelper: t(locale, "ui.accept.storyHelper"),
            storyPlaceholder: t(locale, "ui.accept.storyPlaceholder"),
            cutoffTitle: t(locale, "ui.accept.cutoffTitle"),
            cutoffHelper: t(locale, "ui.accept.cutoffHelper"),
            submit: t(locale, "ui.accept.submit"),
            error: t(locale, "ui.accept.error"),
            hoursInvalid: t(locale, "ui.accept.hoursInvalid"),
            alreadyBody: t(locale, "ui.accept.alreadyBody"),
            address: {
              label: t(locale, "ui.accept.labelAddress"),
              placeholder: t(locale, "ui.accept.addressPlaceholder"),
              hint: t(locale, "ui.accept.addressHint"),
              verified: t(locale, "ui.accept.addressVerified"),
              searching: t(locale, "ui.accept.addressSearching"),
              noResults: t(locale, "ui.accept.addressNoResults"),
            },
            hours: {
              title: t(locale, "ui.accept.hoursTitle"),
              note: t(locale, "ui.accept.hoursNote"),
              weekdays: t(locale, "ui.accept.hoursWeekdays"),
              open: t(locale, "ui.accept.openLabel"),
              closed: t(locale, "ui.accept.closedLabel"),
              opensAt: t(locale, "ui.accept.opensAtLabel"),
              closesAt: t(locale, "ui.accept.closesAtLabel"),
              expand: t(locale, "ui.accept.hoursExpand"),
              collapse: t(locale, "ui.accept.hoursCollapse"),
              days,
              saturday: t(locale, "ui.accept.daysLong.sat"),
              sunday: t(locale, "ui.accept.daysLong.sun"),
            },
          }}
        />
      </div>
    </main>
  );
}
