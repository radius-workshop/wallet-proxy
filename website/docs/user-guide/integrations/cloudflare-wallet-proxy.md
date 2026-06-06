# Cloudflare Wallet Proxy

Hermes agents can use Radius wallets without mounting CDP, Privy, or Para credentials into the agent runtime by pointing `radius-cli` at a Cloudflare Worker wallet proxy.

The Worker stores provider credentials as Cloudflare Worker Secrets, maps a wallet alias to a provider wallet or account, and exposes only address, status, capabilities, and signing endpoints. The agent receives a Worker URL, wallet alias, and optional auth material.

```env
RADIUS_WALLET=proxy
RADIUS_WALLET_PROXY_URL=https://<your-worker-domain>
RADIUS_WALLET_ALIAS=agent0-main
RADIUS_WALLET_PROXY_TOKEN=<optional bearer token>
```

For production, protect the Worker with Cloudflare Zero Trust Access service tokens. The Worker also supports `WALLET_PROXY_BEARER_TOKEN` as an optional fallback, but Access should be the main service-to-service boundary.

Wallet aliases are configured in `WALLET_PROXY_WALLETS`:

```json
{
  "agent0-main": { "provider": "privy", "walletId": "wlt_..." },
  "agent1-main": { "provider": "cdp", "accountName": "radius-agent-1", "address": "0x..." },
  "agent2-main": { "provider": "para", "email": "agent2@radiustech.xyz", "walletId": "...", "address": "0x..." }
}
```

The proxy is intentionally thin. It does not export private keys and does not replace provider-native policy, rate limits, Cloudflare Access policy, or future Radius transaction coordination primitives.
