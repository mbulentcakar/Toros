import { createHash } from 'node:crypto';

/**
 * RFC 8785 JSON Canonicalization Scheme, restricted to the value space Toros
 * actually serialises.
 *
 * Two independent implementations must agree byte for byte, because the digest
 * of an envelope computed on one node is compared against a digest computed on
 * another (SPEC §5) and the event chain rehashes stored payloads (SPEC §8.1).
 * That is why this lives in contracts and not in each package.
 */

/**
 * A JSON value Toros is willing to canonicalize.
 *
 * Both container arms are `readonly`, and that is deliberate rather than
 * decorative. The values actually canonicalized here are contract records —
 * envelopes, receipts, event payloads — and those are declared with `readonly`
 * members precisely because nothing downstream may mutate them. A mutable
 * `JsonValue[]` would make every one of them unassignable, and the only way
 * out at each call site would be a cast, which is exactly the escape hatch the
 * readonly modifiers exist to prevent.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * RFC 8785 orders object members by their UTF-16 code units. `Array.prototype.sort`
 * with no comparator already compares UTF-16 code units, but relying on the
 * default would also coerce via `toString`; comparing explicitly keeps the
 * intent legible and the behaviour pinned.
 */
function compareCodeUnits(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

/**
 * RFC 8785 §3.2.2.2 defers number formatting to ECMAScript's `Number::toString`,
 * which is what `JSON.stringify` emits — shortest round-tripping form. The only
 * work left is rejecting values ECMAScript would render as `null`.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`canonicalize: non-finite number is not representable (${String(value)})`);
  }
  // -0 serialises as "0" per RFC 8785, which JSON.stringify already does.
  return JSON.stringify(value);
}

/**
 * RFC 8785 §3.2.2.3 uses the ECMAScript `JSON.stringify` string production:
 * the short escapes, \u00XX for the remaining C0 controls, and literal UTF-8
 * for everything else. Lone surrogates round-trip as escapes, which is what
 * `JSON.stringify` emits, so it is used directly rather than reimplemented.
 */
function serializeString(value: string): string {
  return JSON.stringify(value);
}

/*
 * `Array.isArray` is typed `(arg: any) => arg is any[]`, and `readonly T[]` is
 * not `any[]`, so it does not remove the array arm from the union in the
 * negative branch. These two guards do what it cannot express, without a cast
 * at the call site.
 */
function isJsonArray(value: object): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isJsonObject(value: object): value is { readonly [key: string]: JsonValue } {
  return !Array.isArray(value);
}

function serialize(value: JsonValue, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'string':
      return serializeString(value);
    default:
      break;
  }

  if (isJsonArray(value)) {
    const items = value.map((item, index) => serialize(item, `${path}[${index}]`));
    return `[${items.join(',')}]`;
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort(compareCodeUnits);
    const members = keys.map((key) => {
      const member = value[key];
      // `undefined` is not a JSON value. JSON.stringify would silently drop the
      // member, which would let two different objects share a digest — exactly
      // the collision the digest exists to prevent. Refuse instead.
      if (member === undefined) {
        throw new TypeError(`canonicalize: undefined at ${path}.${key}; omit the key or use null`);
      }
      return `${serializeString(key)}:${serialize(member, `${path}.${key}`)}`;
    });
    return `{${members.join(',')}}`;
  }

  throw new TypeError(`canonicalize: unsupported value of type ${typeof value} at ${path}`);
}

/** Canonical UTF-8 JSON text for `value`, per RFC 8785. */
export function canonicalize(value: JsonValue): string {
  return serialize(value, '$');
}

/** Lowercase hex SHA-256 over the canonical form of `value`. */
export function digest(value: JsonValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** The `prev_hash` of the first row in a chain (SPEC §8.1). */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * One link of the event chain: `SHA-256(prev_hash || canonical_json(payload))`.
 *
 * `prev_hash` is mixed in as its hex text, not as decoded bytes, so that the
 * chain can be recomputed from what the database stores without a decode step
 * that two implementations could disagree about.
 */
export function chainHash(prevHash: string, payload: JsonValue): string {
  if (!/^[0-9a-f]{64}$/.test(prevHash)) {
    throw new TypeError(`chainHash: prevHash must be 64 lowercase hex characters, got ${prevHash}`);
  }
  return createHash('sha256').update(prevHash, 'utf8').update(canonicalize(payload), 'utf8').digest('hex');
}
