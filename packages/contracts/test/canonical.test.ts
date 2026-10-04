import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';

import { canonicalize, chainHash, digest, GENESIS_HASH } from '../src/canonical.js';

describe('canonicalize — RFC 8785', () => {
  it('sorts object keys by UTF-16 code unit, not by locale', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
    // Uppercase precedes lowercase in code-unit order; a locale collator would
    // interleave them, which would make two nodes disagree on the digest.
    assert.equal(canonicalize({ a: 1, B: 2 }), '{"B":2,"a":1}');
  });

  it('sorts by code unit at every depth', () => {
    assert.equal(canonicalize({ z: { y: 1, x: 2 }, a: 3 }), '{"a":3,"z":{"x":2,"y":1}}');
  });

  it('orders a shorter key before its own prefix extension', () => {
    assert.equal(canonicalize({ ab: 1, a: 2 }), '{"a":2,"ab":1}');
  });

  it('preserves array order', () => {
    assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
  });

  it('emits no insignificant whitespace', () => {
    assert.equal(canonicalize({ a: [1, { b: 2 }] }), '{"a":[1,{"b":2}]}');
  });

  it('uses the shortest round-tripping number form', () => {
    assert.equal(canonicalize(1.0), '1');
    assert.equal(canonicalize(-0), '0');
    assert.equal(canonicalize(1e21), '1e+21');
    assert.equal(canonicalize(0.1), '0.1');
  });

  it('rejects non-finite numbers rather than emitting null', () => {
    // JSON.stringify turns these into null, which would silently collapse two
    // different envelopes onto one digest.
    assert.throws(() => canonicalize(Number.NaN), TypeError);
    assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), TypeError);
  });

  it('rejects undefined members rather than dropping them', () => {
    const withUndefined = { a: 1, b: undefined } as unknown as Record<string, never>;
    assert.throws(() => canonicalize(withUndefined), TypeError);
  });

  it('escapes control characters and preserves non-ASCII literally', () => {
    assert.equal(canonicalize('a\nb'), '"a\\nb"');
    assert.equal(canonicalize(''), '"\\u0001"');
    assert.equal(canonicalize('ü'), '"ü"');
  });

  it('is stable across insertion order — the property the digest relies on', () => {
    const a = { job_id: 'x', max_actions: 20, objective: 'o' };
    const b = { objective: 'o', job_id: 'x', max_actions: 20 };
    assert.equal(canonicalize(a), canonicalize(b));
    assert.equal(digest(a), digest(b));
  });
});

describe('digest', () => {
  it('is SHA-256 over the canonical text, as UTF-8', () => {
    const value = { a: 1 };
    const expected = createHash('sha256').update('{"a":1}', 'utf8').digest('hex');
    assert.equal(digest(value), expected);
  });

  it('changes when any field changes', () => {
    assert.notEqual(digest({ max_actions: 20 }), digest({ max_actions: 21 }));
  });

  it('returns 64 lowercase hex characters', () => {
    assert.match(digest({ a: 1 }), /^[0-9a-f]{64}$/);
  });
});

describe('chainHash — SPEC §8.1', () => {
  it('is SHA-256 over prev_hash text followed by canonical payload', () => {
    const expected = createHash('sha256')
      .update(GENESIS_HASH, 'utf8')
      .update('{"a":1}', 'utf8')
      .digest('hex');
    assert.equal(chainHash(GENESIS_HASH, { a: 1 }), expected);
  });

  it('genesis is 64 zeroes', () => {
    assert.equal(GENESIS_HASH, '0'.repeat(64));
    assert.match(GENESIS_HASH, /^[0-9a-f]{64}$/);
  });

  it('differs when the predecessor differs, even for an identical payload', () => {
    // This is the whole point of the chain: an identical event at a different
    // position in history gets a different hash, so rows cannot be reordered
    // or replayed without detection.
    const first = chainHash(GENESIS_HASH, { kind: 'job.created' });
    const second = chainHash(first, { kind: 'job.created' });
    assert.notEqual(first, second);
  });

  it('refuses a malformed predecessor rather than hashing it anyway', () => {
    assert.throws(() => chainHash('nothex', { a: 1 }), TypeError);
    assert.throws(() => chainHash('ABC', { a: 1 }), TypeError);
    // Uppercase hex is rejected: the chain is recomputed from stored text, so
    // two spellings of the same value must not both be accepted.
    assert.throws(() => chainHash('a'.repeat(64).toUpperCase(), { a: 1 }), TypeError);
    assert.throws(() => chainHash('0'.repeat(63), { a: 1 }), TypeError);
  });

  it('detects an edit anywhere in a chain when recomputed', () => {
    const payloads = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const hashes: string[] = [];
    let prev = GENESIS_HASH;
    for (const payload of payloads) {
      prev = chainHash(prev, payload);
      hashes.push(prev);
    }

    // Tamper with the middle row and recompute forward.
    let recomputed = GENESIS_HASH;
    const tampered = [{ n: 1 }, { n: 99 }, { n: 3 }];
    const recomputedHashes: string[] = [];
    for (const payload of tampered) {
      recomputed = chainHash(recomputed, payload);
      recomputedHashes.push(recomputed);
    }

    assert.equal(recomputedHashes[0], hashes[0], 'rows before the edit still match');
    assert.notEqual(recomputedHashes[1], hashes[1]);
    assert.notEqual(recomputedHashes[2], hashes[2], 'the break propagates to every later row');
  });
});
