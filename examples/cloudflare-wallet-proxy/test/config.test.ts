import { describe, expect, it } from 'vitest';
import {
  aliasToSecretSuffix,
  handleRequest,
  paraUserShareSecretName,
  parseWalletConfig,
} from '../src/index.js';

describe('wallet proxy config', () => {
  it('normalizes Para user-share secret names from aliases', () => {
    expect(aliasToSecretSuffix('agent2-main')).toBe('AGENT2_MAIN');
    expect(paraUserShareSecretName('agent2-main', {})).toBe('PARA_USER_SHARE_AGENT2_MAIN');
    expect(paraUserShareSecretName('agent2-main', { userShareSecret: 'PARA_USER_SHARE_CUSTOM' })).toBe(
      'PARA_USER_SHARE_CUSTOM',
    );
  });

  it('parses supported wallet provider config', () => {
    const wallets = parseWalletConfig(JSON.stringify({
      'agent0-main': { provider: 'privy', walletId: 'wlt_123' },
      'agent1-main': { provider: 'cdp', accountName: 'radius-agent-1', address: '0x0000000000000000000000000000000000000001' },
      'agent2-main': { provider: 'para', email: 'agent2@radiustech.xyz', walletId: 'wallet-id', address: '0x0000000000000000000000000000000000000002' },
    }));

    expect(wallets['agent0-main'].provider).toBe('privy');
    expect(wallets['agent1-main'].provider).toBe('cdp');
    expect(wallets['agent2-main'].provider).toBe('para');
  });

  it('requires optional bearer token when configured', async () => {
    const denied = await handleRequest(new Request('https://worker.example/health'), {
      WALLET_PROXY_WALLETS: '{}',
      WALLET_PROXY_BEARER_TOKEN: 'secret-token',
    });

    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });

    const allowed = await handleRequest(new Request('https://worker.example/health', {
      headers: { Authorization: 'Bearer secret-token' },
    }), {
      WALLET_PROXY_WALLETS: '{}',
      WALLET_PROXY_BEARER_TOKEN: 'secret-token',
    });

    expect(allowed.status).toBe(200);
  });

  it('returns capabilities without provider secrets', async () => {
    const res = await handleRequest(new Request('https://worker.example/v1/wallets/agent0-main/capabilities'), {
      WALLET_PROXY_WALLETS: JSON.stringify({
        'agent0-main': { provider: 'privy', walletId: 'wlt_123' },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      provider: 'privy',
      alias: 'agent0-main',
      capabilities: {
        exportPrivateKey: false,
        rawSecretReadback: false,
        localPolicyEngine: false,
        signMessage: true,
      },
    });
  });
});
