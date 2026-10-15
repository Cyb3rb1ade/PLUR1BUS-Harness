import inventory from './shipped-models.json' with { type: 'json' };
/** Shared by setup and release qualification. Discovery/evaluation may never redefine required coverage. */
export const shippedModels = inventory.models;
export function confirmedShippedModel(m: {provider:string;approval:string;discovery:string}): boolean {
  return m.approval === 'owner_confirmed' &&
    (!['openai','google'].includes(m.provider) || m.discovery === 'authenticated_models_list');
}
export function setupDefault(provider: string, available: readonly { provider: string; id: string }[]): string {
  const pin = shippedModels.find(m => m.provider === provider && confirmedShippedModel(m));
  return pin && available.some(m => m.provider === provider && m.id === pin.model) ? `${provider}/${pin.model}` : '';
}
export function pendingShippedModels(): string[] {
  return shippedModels.filter(m => !confirmedShippedModel(m)).map(m => `${m.provider}/${m.model}`);
}
