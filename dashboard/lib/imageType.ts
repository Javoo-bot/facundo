// What an uploaded image ACTUALLY is, read from its magic bytes.
//
// Why this exists: `File.type` in a multipart upload is whatever the client
// claims, and phones/browsers routinely get it wrong — the common case is WebP
// bytes announced as `image/jpeg` (saving an image off the web, or a modern
// Android share sheet). Trusting the declared type silently poisoned two
// things downstream: the R2 object's Content-Type, and the media_type we hand
// the vision models. Anthropic rejects the mismatch outright with
//
//   "The image was specified using the image/jpeg media type, but the image
//    appears to be a image/webp image"
//
// which surfaced to the florist as "No AI provider returned a usable verdict"
// and a held 30% — an OUR-side failure dressed up as a finding about their
// photo. (Seen for real in QA on 2026-08-20, order #MOCK-9304.)
//
// Pure and dependency-free so it unit-tests under plain `node --test`.

export type ImageMedia = "image/jpeg" | "image/png" | "image/webp";

/** The three types the delivery-photo pipeline can actually handle. */
export const SUPPORTED_IMAGE_MEDIA: readonly ImageMedia[] = ["image/jpeg", "image/png", "image/webp"];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function at(b: Uint8Array, i: number): number {
  return i < b.length ? b[i] : -1;
}

function matches(b: Uint8Array, offset: number, sig: readonly number[]): boolean {
  return sig.every((byte, i) => at(b, offset + i) === byte);
}

/** ASCII compare without allocating a decoder — used for RIFF/WEBP tags. */
function tag(b: Uint8Array, offset: number, ascii: string): boolean {
  return matches(b, offset, Array.from(ascii, (c) => c.charCodeAt(0)));
}

/**
 * The image's real media type, or `null` when the bytes are not one of the
 * three supported formats (an unreadable upload, a HEIC, a PDF renamed .jpg).
 * `null` is a deliberate outcome, not an error: the caller should refuse the
 * upload with a message the florist can act on rather than store something the
 * verifier will choke on later.
 */
export function sniffImageMedia(bytes: ArrayBuffer | Uint8Array): ImageMedia | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // JPEG: SOI marker FF D8, then any marker (FF ..). EXIF/JFIF variants all share it.
  if (at(b, 0) === 0xff && at(b, 1) === 0xd8 && at(b, 2) === 0xff) return "image/jpeg";
  if (matches(b, 0, PNG_SIGNATURE)) return "image/png";
  // WebP: "RIFF" <4-byte little-endian size> "WEBP".
  if (tag(b, 0, "RIFF") && tag(b, 8, "WEBP")) return "image/webp";
  return null;
}

/** Whether the client's declared type disagrees with the bytes. Only used for
 *  logging — the bytes are authoritative either way — but worth recording,
 *  because a spike in mismatches is a client-side story worth knowing. */
export function mediaTypeMismatch(declared: string | null | undefined, actual: ImageMedia): boolean {
  return (declared ?? "").toLowerCase() !== actual;
}

/** File extension for an object key. Matches the media type exactly, so the R2
 *  key, its Content-Type and the verifier all describe the same bytes. */
export function extensionFor(media: ImageMedia): "jpg" | "png" | "webp" {
  return media === "image/png" ? "png" : media === "image/webp" ? "webp" : "jpg";
}
