/** RE-01's data-only wire projection; implemented by the schema generator. */
export interface EngineRpcSurface {
  definitions: Record<string, unknown>;
  methods: Record<string, unknown>;
  notifications: Record<string, unknown>;
  engineEvent: unknown;
}
export const engineContract: Record<string, unknown>;
export function contractWire(value: unknown): unknown;
export function engineRpcSurface(): EngineRpcSurface;
export function syncEngineSchema(
  schemaPath: string | URL,
  writeFile: (path: string | URL, text: string) => void,
): Record<string, unknown>;
