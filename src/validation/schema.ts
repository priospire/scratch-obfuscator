import {Ajv} from 'ajv';
import type {ErrorObject, ValidateFunction} from 'ajv';
import definitions from './schemas/sb3_definitions.json' with {type: 'json'};
import schema from './schemas/sb3_schema.json' with {type: 'json'};
import {InputError} from '../errors.js';
import {isRecord} from '../model/json.js';

const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
ajv.addSchema(vmAuthoritativeDefinitions());
const validate: ValidateFunction = ajv.compile(schema);

function vmAuthoritativeDefinitions(): Record<string, unknown> {
  const overlaid = structuredClone(definitions) as unknown;
  if (!isRecord(overlaid) || !isRecord(overlaid['definitions'])) throw new Error('bundled Scratch schema definitions are malformed');
  const broadcastPrimitive = overlaid['definitions']['broadcast_primitive'];
  if (!isRecord(broadcastPrimitive) || !Array.isArray(broadcastPrimitive['items']) || !isRecord(broadcastPrimitive['items'][2])) {
    throw new Error('bundled Scratch broadcast primitive schema is malformed');
  }
  // Scratch VM 15.1.0 accepts [11, name, null] and resolves it by name on load.
  // Keep the pinned parser schema intact and relax only that VM-authoritative tuple slot.
  broadcastPrimitive['items'][2] = {...broadcastPrimitive['items'][2], type: ['string', 'null']};
  return overlaid;
}

function describeError(error: ErrorObject | null | undefined): string {
  if (!error) return 'does not match the Scratch 3 schema';
  const location = error.instancePath.length > 0 ? `$${error.instancePath}` : '$';
  return `${location} ${error.message ?? `violates ${error.schemaPath}`}`;
}

/** Validate against the pinned scratch-parser 6.0.1 schema documents. */
export function validateOfficialSchema(value: unknown): void {
  if (!validate(value)) {
    throw new InputError(`official Scratch 3 schema rejected project: ${describeError(validate.errors?.[0])}`);
  }
}
