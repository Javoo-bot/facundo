import type { HelpMedia as Media } from "@/lib/help/content";

/**
 * The illustration for one answer.
 *
 * Screenshots are captured ONCE, in English, and the numbered labels are
 * rendered as positioned HTML on top rather than burnt into the pixels. That
 * buys three things a per-locale screenshot set doesn't: one asset instead of
 * six, labels that stay correct when the app's copy changes, and labels a
 * screen reader can actually read. The markers themselves are aria-hidden —
 * the numbered list below the image is the accessible copy, and it reads
 * perfectly well on its own if the image never loads.
 *
 * `callouts` may be empty: plenty of answers want a picture with no annotation.
 */
export default function HelpMedia({
  media,
  alt,
  labels,
}: {
  media: Media;
  alt: string;
  /** Callout number -> already-localized label. */
  labels: Map<number, string>;
}) {
  if (media.kind === "video") {
    return (
      <figure className="fc-help-media">
        {/* Captions come from the per-locale <track> elements below. */}
        <video controls preload="none" poster={media.poster} playsInline style={{ width: "100%", borderRadius: 12, display: "block" }}>
          <source src={media.src} type="video/mp4" />
          {media.captions.map((loc) => (
            <track key={loc} kind="captions" srcLang={loc} src={`${media.src.replace(/\.mp4$/, "")}.${loc}.vtt`} />
          ))}
        </video>
      </figure>
    );
  }

  const callouts = media.callouts ?? [];
  return (
    <figure className="fc-help-media">
      <div className="fc-help-shot">
        {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no next/image loader on Workers */}
        <img src={media.src} alt={alt} loading="lazy" />
        {callouts.map((c) => (
          <span key={c.n} className="fc-help-pin" aria-hidden="true" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
            {c.n}
          </span>
        ))}
      </div>
      {callouts.length > 0 && (
        <figcaption>
          <ol className="fc-help-keys">
            {callouts.map((c) => (
              <li key={c.n}>
                <span className="fc-help-keynum" aria-hidden="true">
                  {c.n}
                </span>
                {labels.get(c.n) ?? ""}
              </li>
            ))}
          </ol>
        </figcaption>
      )}
    </figure>
  );
}
