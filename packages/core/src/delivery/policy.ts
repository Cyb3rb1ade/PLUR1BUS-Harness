import { publicKey } from '@plur1bus/channels-buzz';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { ChannelIdentity } from '../identity/service.ts';
/** Transport allowlists are re-read for each attempt. The adapter independently checks them when sending. */
export function deliveryAllowed(config: HarnessConfig, i: ChannelIdentity): boolean {
    const c = (config.channels as unknown as Record<string, Record<string, unknown>>)[i.channel];
    if (!c || c.enabled !== true)
        return false;
    const list = i.channel === 'buzz' ? c.senderAllowlist : ['discord', 'matrix', 'slack'].includes(i.channel) ? c.dmAllowlist : c.allowlist;
    if (!Array.isArray(list))
        return false;
    if (i.channel === 'buzz')
        return list.some(v => { try {
            return typeof v === 'string' && publicKey(v) === i.userId;
        }
        catch {
            return false;
        } });
    return list.includes(i.userId);
}
