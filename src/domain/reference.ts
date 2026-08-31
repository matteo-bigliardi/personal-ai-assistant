import { InvalidInputError, NotFoundError } from "./errors.js";

/**
 * Short identifiers for things chat cannot address by name.
 *
 * Projects are referred to by name, because names are unique and people say
 * them. Task titles and reminder messages are not unique, so those need an id
 * — but a full 36-character UUID would be paid for in every listing, on every
 * turn. Instead the first eight characters are shown and accepted back, and
 * resolved to exactly one row here.
 */

/** How much of the id is shown to the model and accepted back from it. */
export const REF_LENGTH = 8;

/** Shorter references are too likely to be ambiguous to be worth resolving. */
const MIN_REF_LENGTH = 4;

/** The reference as it is shown back to the model. */
export function shortRef(entity: { id: string }): string {
  return entity.id.slice(0, REF_LENGTH);
}

/**
 * Validates and normalises a reference before it reaches a LIKE pattern.
 *
 * The character check is not cosmetic: without it a `%` coming from the model
 * would act as a wildcard and widen the query to rows nobody asked for.
 */
export function normaliseRef(raw: string, what: string): string {
  const ref = raw.trim().toLowerCase();
  if (!/^[0-9a-f-]+$/.test(ref) || ref.length < MIN_REF_LENGTH || ref.length > 36) {
    throw new InvalidInputError(
      `"${raw}" is not a ${what} id. Use the ${REF_LENGTH}-character id shown next to the ${what}.`,
    );
  }
  return ref;
}

/**
 * Picks the single match for a prefix, or explains why it cannot. An ambiguous
 * reference is refused rather than resolved to whichever row came back first.
 */
export function resolveOne<T>(matches: T[], ref: string, what: string): T {
  const [first] = matches;
  if (!first) throw new NotFoundError(`No ${what} with id "${ref}".`);
  if (matches.length > 1) {
    throw new InvalidInputError(
      `The id "${ref}" matches more than one ${what}. List them again and use a longer id.`,
    );
  }
  return first;
}
