import {describe, expect, it} from 'vitest';
import {compareUtf8, DeterministicGenerator, sha256} from '../src/deterministic.js';

const seed = new Uint8Array(Array.from({length: 32}, (_, index) => index));

describe('DeterministicGenerator', () => {
  it('repeats a byte and identifier stream exactly', () => {
    const first = new DeterministicGenerator(seed, 'test');
    const second = new DeterministicGenerator(seed, 'test');
    expect(first.bytes(70)).toEqual(second.bytes(70));
    expect(first.id('b_', 24)).toBe(second.id('b_', 24));
  });

  it('separates domains and forks', () => {
    const first = new DeterministicGenerator(seed, 'one');
    const second = new DeterministicGenerator(seed, 'two');
    expect(first.bytes(32)).not.toEqual(second.bytes(32));
    expect(first.fork('child').bytes(32)).not.toEqual(first.fork('other').bytes(32));
  });

  it('generates bounded values and deterministic shuffles', () => {
    const first = new DeterministicGenerator(seed, 'bounded');
    const values = Array.from({length: 1_000}, () => first.integer(7));
    expect(values.every(value => value >= 0 && value < 7)).toBe(true);
    expect(new Set(values).size).toBe(7);

    const left = new DeterministicGenerator(seed, 'shuffle').shuffle([1, 2, 3, 4, 5]);
    const right = new DeterministicGenerator(seed, 'shuffle').shuffle([1, 2, 3, 4, 5]);
    expect(left).toEqual(right);
    expect([...left].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new DeterministicGenerator(seed, 'empty').shuffle([])).toEqual([]);
    const booleans = Array.from({length: 64}, () => first.boolean());
    expect(booleans).toContain(true);
    expect(booleans).toContain(false);
  });

  it('rejects unsafe ranges and prefixes', () => {
    const generator = new DeterministicGenerator(seed, 'errors');
    expect(() => generator.bytes(-1)).toThrow(RangeError);
    expect(() => generator.integer(0)).toThrow(RangeError);
    expect(() => generator.integer(0x1_0000_0001)).toThrow(RangeError);
    expect(() => generator.id('1_')).toThrow('unsafe ID prefix');
  });
});

describe('hash and ordering helpers', () => {
  it('hashes all parts in order', () => {
    expect(Buffer.from(sha256(Buffer.from('a'), Buffer.from('bc'))).toString('hex'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares UTF-8 bytes without locale dependence', () => {
    expect(compareUtf8('a', 'b')).toBeLessThan(0);
    expect(compareUtf8('same', 'same')).toBe(0);
    expect(compareUtf8('é', 'z')).toBeGreaterThan(0);
  });
});
