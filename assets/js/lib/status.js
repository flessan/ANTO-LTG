// Three separate facts about every catalog record. Keep them apart in the UI and in the filters:
//   * publication  - decided by the automated rules (scripts/lib/publication.mjs): `published` or `unavailable`.
//   * provenance   - how the record was produced: `automated` (crawled from WinGet metadata) or
//                    `maintainer_curated` (written from official pages by a maintainer).
//   * review       - decided only by a human maintainer: `verified` or `not_reviewed`.
// None of them is a safety rating.

// Values of the single "status" filter. '' means any record.
export const STATUS_FILTERS = Object.freeze(['', 'published', 'unavailable', 'verified']);

export const publicationState = (item) => item?.publication?.state ?? null;
export const provenanceOf = (item) => item?.publication?.method ?? null;
export const isVerified = (item) => item?.verification_status === 'verified';

export function matchesStatus(item, status) {
  switch (status) {
    case 'published': return publicationState(item) === 'published';
    case 'unavailable': return publicationState(item) === 'unavailable';
    case 'verified': return isVerified(item);
    default: return true;
  }
}
