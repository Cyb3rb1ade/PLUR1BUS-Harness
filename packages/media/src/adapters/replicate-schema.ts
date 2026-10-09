import { MediaError } from '../types.ts';
import type { ImageRequest, ReferenceImage } from '../types.ts';
/** Replicate prediction input schema: https://replicate.com/docs/reference/http (model/version objects carry an OpenAPI schema). */
export interface InputProp { type?: string; enum?: unknown[]; maximum?: number; minimum?: number; items?: { type?: string } }
export type InputSchema = Record<string, InputProp>;
export interface ModelRef { owner: string; name: string; version?: string }
export function parseModelRef(model: string): ModelRef | undefined {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?::([A-Za-z0-9]+))?$/.exec(model);
  return m ? { owner: m[1]!, name: m[2]!, ...(m[3] ? { version: m[3] } : {}) } : undefined;
}
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
/** Accepts a model document (latest_version.openapi_schema) or a version document (openapi_schema). */
export function parseInputSchema(doc: Record<string, unknown>): InputSchema | undefined {
  const schema = object(object(doc.latest_version)?.openapi_schema) ?? object(doc.openapi_schema);
  const props = object(object(object(object(schema?.components)?.schemas)?.Input)?.properties);
  return props && Object.keys(props).length ? props as InputSchema : undefined;
}
const refuse = (): never => { throw new MediaError('unsupported_parameter'); };
const dataUri = (i: ReferenceImage) => `data:image/${i.format};base64,${Buffer.from(i.bytes).toString('base64')}`;
const pick = (schema: InputSchema, names: string[]): string | undefined => names.find(n => Object.hasOwn(schema, n));
function within(prop: InputProp, value: number): number {
  if ((typeof prop.maximum === 'number' && value > prop.maximum) || (typeof prop.minimum === 'number' && value < prop.minimum)) refuse();
  return value;
}
function oneOf(prop: InputProp, value: string): string { if (prop.enum && !prop.enum.includes(value)) refuse(); return value; }
/** Maps a media request onto the model's declared input names. Anything the model cannot take is refused before submission. */
export function mapReplicateInput(req: ImageRequest, schema: InputSchema, edit: boolean): Record<string, unknown> {
  const input: Record<string, unknown> = {}; const set = (names: string[], value: (prop: InputProp) => unknown): void => { const key = pick(schema, names); if (!key) return refuse(); input[key] = value(schema[key]!); };
  set(['prompt'], () => req.prompt);
  if (req.negativePrompt !== undefined) set(['negative_prompt'], () => req.negativePrompt);
  if (req.seed !== undefined) set(['seed'], p => within(p, req.seed!));
  if (req.steps !== undefined) set(['num_inference_steps', 'steps'], p => within(p, req.steps!));
  if (req.guidance !== undefined) set(['guidance_scale', 'guidance', 'cfg'], p => within(p, req.guidance!));
  if (req.aspect !== undefined) set(['aspect_ratio'], p => oneOf(p, req.aspect!));
  if (req.size) {
    const w = pick(schema, ['width']); const h = pick(schema, ['height']); if (!w || !h) refuse();
    input[w!] = within(schema[w!]!, req.size.width); input[h!] = within(schema[h!]!, req.size.height);
  }
  if (req.n !== undefined) { const key = pick(schema, ['num_outputs', 'num_images', 'batch_size']); if (key) input[key] = within(schema[key]!, req.n); else if (req.n > 1) refuse(); }
  if (req.format !== undefined) set(['output_format'], p => { const wanted = req.format === 'jpeg' ? ['jpg', 'jpeg'] : [req.format!]; return p.enum ? oneOf(p, wanted.find(w => p.enum!.includes(w)) ?? wanted[0]!) : wanted[0]; });
  if (edit) {
    const refs = req.referenceImages ?? [];
    if (refs.length) {
      const many = pick(schema, ['input_images', 'image_input', 'images', 'image_urls']); const single = pick(schema, ['image', 'input_image', 'init_image', 'image_prompt']);
      if (single && refs.length === 1) input[single] = dataUri(refs[0]!); else if (many) input[many] = refs.map(dataUri); else refuse();
    }
    if (req.mask) set(['mask', 'mask_image'], () => dataUri(req.mask!));
  }
  return input;
}
