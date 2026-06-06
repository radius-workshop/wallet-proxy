# Cloudflare Wallet Proxy

Cloudflare Worker wallet secret proxy for the `radius-cli` proxy wallet provider. It keeps CDP, Privy, and Para credentials in Cloudflare Worker Secrets while Hermes, Replit, or another agent runtime only receives a Worker URL, wallet alias, and optional bearer token.

This is a thin secret boundary. It delegates signing to provider APIs and SDKs, returns address/signature/status data, and does not implement private key export or a custom wallet policy engine.

## Architecture

```text
Hermes / Replit agent / radius-cli
  RADIUS_WALLET=proxy
  RADIUS_WALLET_PROXY_URL=https://<worker-domain>
  RADIUS_WALLET_ALIAS=agent0-main
  RADIUS_WALLET_PROXY_TOKEN=<optional bearer token>
        |
        v
Cloudflare Worker
  Worker secrets: provider credentials and optional bearer token
  WALLET_PROXY_WALLETS: alias to provider wallet/account mapping
        |
        v
Privy / Coinbase CDP / Para
```

Cloudflare Zero Trust Access is the recommended production auth layer in front of the Worker. The Worker also supports an optional fallback bearer token for simpler deployments.

## Worker API

All responses are JSON. Errors use:

```json
{
  "error": {
    "code": "WALLET_NOT_FOUND",
    "message": "Unknown wallet alias: agent9-main"
  }
}
```

Endpoints:

- `GET /health`
- `GET /v1/wallets/:alias/address`
- `GET /v1/wallets/:alias/status`
- `GET /v1/wallets/:alias/capabilities`
- `POST /v1/wallets/:alias/sign-message`
- `POST /v1/wallets/:alias/sign-typed-data`
- `POST /v1/wallets/:alias/sign-transaction`

`sign-message` body:

```json
{
  "message": "hello"
}
```

`sign-typed-data` body:

```json
{
  "typedData": {
    "domain": {},
    "types": {},
    "primaryType": "Permit",
    "message": {}
  }
}
```

`sign-transaction` accepts either hash mode:

```json
{
  "hash": "0x..."
}
```

or transaction mode:

```json
{
  "transaction": {}
}
```

There is no private-key export endpoint.

## Wallet Alias Config

`WALLET_PROXY_WALLETS` is a JSON object stored in `wrangler.toml` vars or in environment-specific Wrangler config:

```toml
WALLET_PROXY_WALLETS = '''
{
  "agent0-main": { "provider": "privy", "walletId": "wlt_..." },
  "agent1-main": { "provider": "cdp", "accountName": "radius-agent-1", "address": "0x..." },
  "agent2-main": { "provider": "para", "email": "agent2@radiustech.xyz", "walletId": "...", "address": "0x..." }
}
'''
```

Provider config fields:

- Privy: `provider: "privy"`, `walletId`, optional `address`
- CDP: `provider: "cdp"`, `address` or `accountName`
- Para: `provider: "para"`, `address`, optional `email`, optional `walletId`, optional `userShareSecret`

For Para alias `agent2-main`, the default user-share secret is `PARA_USER_SHARE_AGENT2_MAIN`. Set `userShareSecret` in the wallet config to override it.

## Worker Secrets

Optional fallback auth:

```bash
npx wrangler secret put WALLET_PROXY_BEARER_TOKEN
```

Privy:

```bash
npx wrangler secret put PRIVY_APP_ID
npx wrangler secret put PRIVY_APP_SECRET
```

Coinbase CDP:

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
npx wrangler secret put CDP_WALLET_SECRET
```

Para:

```bash
npx wrangler secret put PARA_API_KEY
npx wrangler secret put PARA_USER_SHARE_AGENT2_MAIN
```

If a Para user share is larger than Cloudflare's single text-secret limit, split it across sequential chunk secrets instead:

```bash
npx wrangler secret put PARA_USER_SHARE_AGENT2_MAIN_0
npx wrangler secret put PARA_USER_SHARE_AGENT2_MAIN_1
```

Never store these values in the agent runtime.

## Deploy

Install and validate:

```bash
npm install
npm run typecheck
npm test
npm run deploy -- --dry-run
```

Deploy:

```bash
npx wrangler deploy
```

## Cloudflare Access

For production, put the Worker behind Cloudflare Zero Trust Access:

1. Create a self-hosted Access application for the Worker hostname.
2. Create a service token for each agent or agent group.
3. Add an Access policy that allows those service tokens.
4. Send the service token headers from the agent runtime:

```http
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

The Worker does not validate Access JWTs itself. Access should be configured at the Cloudflare edge. `WALLET_PROXY_BEARER_TOKEN` is only a fallback.

## Agent Env Vars

After deployment, configure `radius-cli`:

```env
RADIUS_WALLET=proxy
RADIUS_WALLET_PROXY_URL=https://<your-worker-domain>
RADIUS_WALLET_ALIAS=agent0-main
RADIUS_WALLET_PROXY_TOKEN=<optional bearer token>

# If using Cloudflare Access service tokens:
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
```

## Provider Notes

Privy uses REST/RPC from the Worker:

- `GET /wallets/{walletId}` for address lookup
- `POST /wallets/{walletId}/rpc` for `personal_sign`, `eth_signTypedData_v4`, `secp256k1_sign`, and `eth_signTransaction`

CDP uses `@coinbase/cdp-sdk` in `nodejs_compat` mode. Accounts resolve by configured `address` or by `accountName` with `getOrCreateAccount`.

Para uses `@getpara/server-sdk` and `@getpara/viem-v2-integration`. The wallet config should include `address`, and the user share should live in a Worker secret. If Para provides a hosted signing proxy for the target deployment, prefer that hosted signing path instead of storing the user share in this Worker.

For Cloudflare Workers, configure Para's hosted/offloaded MPC computation URL when available. The example config sets `PARA_OFFLOAD_MPC_COMPUTATION_URL` for the beta Para/Capsule environment so signing does not rely on completing MPC work inside the Worker runtime.

## Audit Logging

The Worker logs one structured JSON object per request with timestamp, request ID, alias, provider, operation, and result. It does not log secrets, bearer tokens, provider auth headers, request bodies, or signatures.
