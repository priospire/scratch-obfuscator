import {createHash, createHmac} from 'node:crypto';

const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class DeterministicGenerator {
  readonly #seed: Uint8Array;
  readonly #domain: string;
  #counter = 0n;
  #pool = new Uint8Array(0);
  #offset = 0;

  constructor(seed: Uint8Array, domain: string) {
    this.#seed = seed.slice();
    this.#domain = domain;
  }

  fork(domain: string): DeterministicGenerator {
    return new DeterministicGenerator(this.#seed, `${this.#domain}\u0000${domain}`);
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError('length must be a non-negative safe integer');
    }
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.#byte();
    }
    return result;
  }

  integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
      throw new RangeError('maxExclusive must be between 1 and 2^32');
    }
    const range = 0x1_0000_0000;
    const limit = range - (range % maxExclusive);
    let value: number;
    do {
      const data = this.bytes(4);
      value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    } while (value >= limit);
    return value % maxExclusive;
  }

  boolean(): boolean {
    return this.integer(2) === 1;
  }

  id(prefix: string, length = 18): string {
    if (!/^[A-Za-z][A-Za-z0-9_]*_$/.test(prefix)) {
      throw new Error(`unsafe ID prefix: ${prefix}`);
    }
    let result = prefix;
    while (result.length < prefix.length + length) {
      result += ID_ALPHABET[this.integer(ID_ALPHABET.length)];
    }
    return result;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = this.integer(index + 1);
      [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
    }
    return copy;
  }

  #byte(): number {
    if (this.#offset >= this.#pool.length) {
      const counter = Buffer.allocUnsafe(8);
      counter.writeBigUInt64BE(this.#counter);
      this.#counter += 1n;
      this.#pool = createHmac('sha256', this.#seed)
        .update('scratch-obfuscator\u0000', 'utf8')
        .update(this.#domain, 'utf8')
        .update(counter)
        .digest();
      this.#offset = 0;
    }
    const value = new DataView(this.#pool.buffer, this.#pool.byteOffset + this.#offset, 1).getUint8(0);
    this.#offset += 1;
    return value;
  }
}

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
