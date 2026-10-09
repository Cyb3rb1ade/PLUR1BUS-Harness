// Additive entry point for the MG-2 adapter layer. The adapters themselves still live in ../adapters.ts and ../coreml.ts.
export * from './config.ts';
export * from './capabilities.ts';
export { ResilientTransport } from './_shared/transport.ts';
export { DetailedMediaError, reasonOf } from './_shared/errors.ts';
export type { ErrorReason } from './_shared/errors.ts';
export type { RetryPolicy } from './_shared/retry.ts';
export { stripMetadata, sanitizeRequest, sniffFormat } from './_shared/images.ts';
export { embedImage } from './_shared/metadata.ts';
export { probeDrawThings } from './drawthings-probe.ts';
export type { ImageModel } from './openrouter-models.ts';
