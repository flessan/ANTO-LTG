// JSON Schema validation (Ajv, draft 2020-12). The schemas in /schemas are the single source of
// truth for the data model: the validator, the generated OpenAPI document and the developer docs
// all read from them.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export async function loadSchemas(schemasDir) {
  const files = (await readdir(schemasDir)).filter((f) => f.endsWith('.schema.json')).sort();
  const schemas = {};
  for (const f of files) schemas[f.replace('.schema.json', '')] = JSON.parse(await readFile(path.join(schemasDir, f), 'utf8'));
  return schemas;
}

export function createValidators(schemas) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  const ids = Object.fromEntries(Object.entries(schemas).map(([name, s]) => [name, s.$id]));
  return {
    ids,
    validate(name, data) {
      const validate = ajv.getSchema(ids[name]);
      if (!validate) throw new Error(`Unknown schema "${name}"`);
      const ok = validate(data);
      return { ok, errors: ok ? [] : (validate.errors ?? []).map(formatError) };
    },
    validateRef(ref, data) {
      const validate = ajv.getSchema(ref);
      if (!validate) throw new Error(`Unknown schema reference "${ref}"`);
      const ok = validate(data);
      return { ok, errors: ok ? [] : (validate.errors ?? []).map(formatError) };
    },
  };
}

function formatError(e) {
  const where = e.instancePath || '(root)';
  const extra = e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : e.params?.allowedValues ? ` (allowed: ${e.params.allowedValues.join(', ')})` : '';
  return `${where}: ${e.message}${extra}`;
}
