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
/**
 * Release qualification: only owner-confirmed pins (`approval: "owner_confirmed"`) are mandatory coverage. Pending candidates are
 * advisory until confirmed; confirming one is the one-line change of its `approval`. Discovery is a setup-preselection concern and
 * does not decide release coverage.
 */
export function releaseRequired(m: { approval: string }): boolean {
  return m.approval === 'owner_confirmed';
}
export function requiredShippedModels(): { provider: string; model: string }[] {
  return shippedModels.filter(releaseRequired).map(({ provider, model }) => ({ provider, model }));
}
export function advisoryShippedModels(): { provider: string; model: string }[] {
  return shippedModels.filter(m => !releaseRequired(m)).map(({ provider, model }) => ({ provider, model }));
}
