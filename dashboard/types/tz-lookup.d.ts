// `tz-lookup` ships no types and has no @types package. It's a single function:
// coordinates in, IANA zone name out. It THROWS on out-of-range input rather
// than returning null, which is why lib/floristTime.ts range-checks first and
// still wraps the call in a try.
declare module "tz-lookup" {
  export default function tzLookup(lat: number, lng: number): string;
}
