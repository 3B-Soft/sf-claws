import { describe, expect, it, vi } from 'vitest';
import { appStore, api, refreshOrg, selectSession } from '../src/lib/state.js';

const orgs = { 'rcmt.my.salesforce.com': { id: 'org-rcmt' }, 'rohealth.my.salesforce.com': { id: 'org-ro' } };

describe('switching tabs between orgs', () => {
  it('never keeps the other org’s session open', async () => {
    vi.spyOn(api, 'resolveOrg').mockImplementation(async (host) => ({ org: orgs[host], client: null }));
    vi.spyOn(api, 'orgLimits').mockResolvedValue(null);
    appStore.set({ screen: 'main', token: 't', context: { isSalesforce: true, host: 'rohealth.my.salesforce.com' } });
    await refreshOrg();
    await selectSession('ro-session');

    appStore.set({ context: { isSalesforce: true, host: 'rcmt.my.salesforce.com' } });
    await refreshOrg();
    expect(appStore.get().org.id).toBe('org-rcmt');
    expect(appStore.get().sessionId).toBe(null);
    await selectSession('rcmt-session');

    // Back to RoHealth: its own last session comes back, not the RCMT one.
    appStore.set({ context: { isSalesforce: true, host: 'rohealth.my.salesforce.com' } });
    await refreshOrg();
    expect(appStore.get().sessionId).toBe('ro-session');
  });
});
