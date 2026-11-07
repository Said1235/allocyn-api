/** A small JSON Schema (2020-12 subset) validator, enough to check API responses against the OpenAPI document. */
type S = Record<string, any>;
export function validate(schema: S, value: unknown, root: S, at = "$"): string[] {
  if (schema.$ref) {
    const name = String(schema.$ref).replace("#/components/schemas/", "");
    return validate(root.components.schemas[name], value, root, at);
  }
  const errs: string[] = [];
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s: S) => validate(s, value, root, at).length === 0).length;
    return ok === 1 ? [] : [`${at}: matches ${ok} of oneOf`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const okType = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!okType) return [`${at}: expected ${types.join("|")}, got ${actual}`];
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: "${value}" does not match ${schema.pattern}`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errs.push(`${at}: not a date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below minimum`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${at}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) errs.push(`${at}: missing "${k}"`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validate(props[k], v, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
      else if (typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, v, root, `${at}.${k}`));
    }
  }
  return errs;
}
