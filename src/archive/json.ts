import {InputError} from '../errors.js';
import type {JsonValue} from '../types.js';

const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true});

/**
 * Parse JSON while rejecting duplicate object member names. JSON.parse normally
 * accepts duplicates and silently keeps the final value, which makes validation
 * ambiguous and can hide a malicious project member.
 */
export function parseUniqueJson(bytes: Uint8Array, label = 'project.json'): JsonValue {
  let source: string;
  try {
    source = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new InputError(`${label} is not valid UTF-8`, {cause: error});
  }

  try {
    const scanner = new UniqueJsonScanner(source, label);
    scanner.scan();
    return JSON.parse(source) as JsonValue;
  } catch (error) {
    if (error instanceof InputError) {
      throw error;
    }
    throw new InputError(`${label} is not valid JSON`, {cause: error});
  }
}

class UniqueJsonScanner {
  readonly #source: string;
  readonly #label: string;
  #position = 0;

  constructor(source: string, label: string) {
    this.#source = source;
    this.#label = label;
  }

  scan(): void {
    this.#skipWhitespace();
    this.#scanValue();
    this.#skipWhitespace();
    if (this.#position !== this.#source.length) {
      this.#syntax('unexpected trailing data');
    }
  }

  #scanValue(): void {
    const character = this.#source[this.#position];
    if (character === '{') {
      this.#scanObject();
    } else if (character === '[') {
      this.#scanArray();
    } else if (character === '"') {
      this.#scanString();
    } else if (character === 't') {
      this.#scanLiteral('true');
    } else if (character === 'f') {
      this.#scanLiteral('false');
    } else if (character === 'n') {
      this.#scanLiteral('null');
    } else if (character === '-' || isDigit(character)) {
      this.#scanNumber();
    } else {
      this.#syntax('expected a JSON value');
    }
  }

  #scanObject(): void {
    this.#position += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.#take('}')) {
      return;
    }

    for (;;) {
      if (this.#source[this.#position] !== '"') {
        this.#syntax('expected an object member name');
      }
      const rawKey = this.#scanString();
      let key: string;
      try {
        key = JSON.parse(rawKey) as string;
      } catch (error) {
        this.#syntax('invalid object member name', error);
      }
      if (keys.has(key)) {
        throw new InputError(`${this.#label} contains duplicate object member ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.#skipWhitespace();
      if (!this.#take(':')) {
        this.#syntax('expected a colon after an object member name');
      }
      this.#skipWhitespace();
      this.#scanValue();
      this.#skipWhitespace();
      if (this.#take('}')) {
        return;
      }
      if (!this.#take(',')) {
        this.#syntax('expected a comma or closing brace');
      }
      this.#skipWhitespace();
    }
  }

  #scanArray(): void {
    this.#position += 1;
    this.#skipWhitespace();
    if (this.#take(']')) {
      return;
    }
    for (;;) {
      this.#scanValue();
      this.#skipWhitespace();
      if (this.#take(']')) {
        return;
      }
      if (!this.#take(',')) {
        this.#syntax('expected a comma or closing bracket');
      }
      this.#skipWhitespace();
    }
  }

  #scanString(): string {
    const start = this.#position;
    this.#position += 1;
    for (;;) {
      const code = this.#source.charCodeAt(this.#position);
      if (Number.isNaN(code)) {
        this.#syntax('unterminated string');
      }
      if (code === 0x22) {
        this.#position += 1;
        return this.#source.slice(start, this.#position);
      }
      if (code === 0x5c) {
        this.#position += 1;
        const escape = this.#source[this.#position];
        if (escape === 'u') {
          const digits = this.#source.slice(this.#position + 1, this.#position + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
            this.#syntax('invalid Unicode escape');
          }
          this.#position += 5;
          continue;
        }
        if (escape === '"' || escape === '\\' || escape === '/' || escape === 'b' || escape === 'f' || escape === 'n' || escape === 'r' || escape === 't') {
          this.#position += 1;
          continue;
        }
        this.#syntax('invalid string escape');
      }
      if (code < 0x20) {
        this.#syntax('unescaped control character in string');
      }
      this.#position += 1;
    }
  }

  #scanNumber(): void {
    const rest = this.#source.slice(this.#position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?/.exec(rest);
    if (match === null) {
      this.#syntax('invalid number');
    }
    if (!Number.isFinite(Number(match[0]))) {
      this.#syntax('number is outside the finite JavaScript range');
    }
    this.#position += match[0].length;
  }

  #scanLiteral(literal: string): void {
    if (!this.#source.startsWith(literal, this.#position)) {
      this.#syntax(`invalid literal`);
    }
    this.#position += literal.length;
  }

  #skipWhitespace(): void {
    while (this.#position < this.#source.length) {
      const character = this.#source[this.#position];
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') {
        break;
      }
      this.#position += 1;
    }
  }

  #take(character: string): boolean {
    if (this.#source[this.#position] !== character) {
      return false;
    }
    this.#position += 1;
    return true;
  }

  #syntax(message: string, cause?: unknown): never {
    throw new InputError(`${this.#label} is not valid JSON at character ${this.#position}: ${message}`, cause === undefined ? undefined : {cause});
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}
