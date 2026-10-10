import type { ProviderDefinition } from "../../../src/composition/auth.ts";
export function definition(id: string, wireFormat: ProviderDefinition['wireFormat'] = 'chat_completions'): ProviderDefinition {
  return { wireFormat, profile: { id, display_name: id, kind: 'api_key', capabilities: ['chat'], base_url: 'https://provider.example/v1', auth_header_scheme: 'Authorization: Bearer {token}', secret_ref: 'key', policy_status: 'allowed', policy_source: 'fixture', policy_checked: '2026-10-10' }, entries: [] };
}
