import { CdpClient } from '@coinbase/cdp-sdk';
import { Para, Environment } from '@getpara/server-sdk';
import { createParaViemAccount } from '@getpara/viem-v2-integration';
import {
  type Address,
  type Hex,
  isAddress,
  isHex,
  stringToHex,
} from 'viem';

export interface Env {
  WALLET_PROXY_WALLETS?: string;
  WALLET_PROXY_ACCESS_AUD?: string;
  WALLET_PROXY_BEARER_TOKEN?: string;
  PRIVY_API_BASE?: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CDP_WALLET_SECRET?: string;
  PARA_API_KEY?: string;
  PARA_ENV?: string;
  PARA_OFFLOAD_MPC_COMPUTATION_URL?: string;
  [key: string]: unknown;
}

type Provider = 'privy' | 'cdp' | 'para';
type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'WALLET_NOT_FOUND'
  | 'INVALID_WALLET_CONFIG'
  | 'INVALID_REQUEST'
  | 'MISSING_SECRET'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

interface BaseWalletConfig {
  provider: Provider;
}

interface PrivyWalletConfig extends BaseWalletConfig {
  provider: 'privy';
  walletId: string;
  address?: string;
}

interface CdpWalletConfig extends BaseWalletConfig {
  provider: 'cdp';
  accountName?: string;
  address?: string;
}

interface ParaWalletConfig extends BaseWalletConfig {
  provider: 'para';
  email?: string;
  walletId?: string;
  address: string;
  userShareSecret?: string;
}

type WalletConfig = PrivyWalletConfig | CdpWalletConfig | ParaWalletConfig;
type WalletMap = Record<string, WalletConfig>;

interface AuditLog {
  ts: string;
  requestId: string;
  alias?: string;
  provider?: Provider;
  operation: string;
  result: 'ok' | 'error';
  code?: ErrorCode;
}

class WalletProxyError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = 'WalletProxyError';
    this.code = code;
    this.status = status;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
  const audit: AuditLog = {
    ts: new Date().toISOString(),
    requestId,
    operation: inferOperation(url.pathname),
    result: 'error',
  };

  try {
    assertAuthorized(request, env);

    if (url.pathname === '/health') {
      if (request.method !== 'GET') {
        throw new WalletProxyError('NOT_FOUND', 'Not found', 404);
      }
      const wallets = parseWalletConfig(env.WALLET_PROXY_WALLETS ?? '{}');
      audit.result = 'ok';
      return jsonResponse({
        ok: true,
        service: 'hermes-wallet-proxy',
        wallets: Object.keys(wallets).length,
        fallbackBearerToken: Boolean(env.WALLET_PROXY_BEARER_TOKEN),
        accessAudienceConfigured: Boolean(env.WALLET_PROXY_ACCESS_AUD),
      });
    }

    const route = parseWalletRoute(url.pathname);
    if (!route) {
      throw new WalletProxyError('NOT_FOUND', 'Not found', 404);
    }

    audit.alias = route.alias;
    audit.operation = route.operation;
    const wallet = getWalletConfig(env, route.alias);
    audit.provider = wallet.provider;

    const response = await dispatchWalletRoute(request, env, route.alias, route.operation, wallet);
    audit.result = 'ok';
    return response;
  } catch (error) {
    const err = toWalletProxyError(error);
    audit.code = err.code;
    return errorResponse(err.code, err.message, err.status);
  } finally {
    console.log(JSON.stringify(audit));
  }
}

function inferOperation(pathname: string): string {
  if (pathname === '/health') return 'health';
  const parts = pathname.split('/').filter(Boolean);
  return parts[3] ?? 'unknown';
}

function parseWalletRoute(pathname: string): { alias: string; operation: string } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'v1' || parts[1] !== 'wallets') {
    return null;
  }
  return {
    alias: decodeURIComponent(parts[2]),
    operation: parts[3],
  };
}

async function dispatchWalletRoute(
  request: Request,
  env: Env,
  alias: string,
  operation: string,
  wallet: WalletConfig,
): Promise<Response> {
  switch (operation) {
    case 'address':
      requireMethod(request, 'GET');
      return jsonResponse({
        provider: wallet.provider,
        alias,
        address: await getAddress(env, wallet),
      });

    case 'status':
      requireMethod(request, 'GET');
      return jsonResponse({
        provider: wallet.provider,
        alias,
        status: 'configured',
        address: await getStatusAddress(env, wallet),
      });

    case 'capabilities':
      requireMethod(request, 'GET');
      return jsonResponse({
        provider: wallet.provider,
        alias,
        capabilities: providerCapabilities(wallet.provider),
      });

    case 'sign-message':
      requireMethod(request, 'POST');
      return signMessage(request, env, alias, wallet);

    case 'sign-typed-data':
      requireMethod(request, 'POST');
      return signTypedData(request, env, alias, wallet);

    case 'sign-transaction':
      requireMethod(request, 'POST');
      return signTransaction(request, env, alias, wallet);

    default:
      throw new WalletProxyError('NOT_FOUND', 'Not found', 404);
  }
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new WalletProxyError('NOT_FOUND', 'Not found', 404);
  }
}

export function parseWalletConfig(raw: string): WalletMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WalletProxyError('INVALID_WALLET_CONFIG', 'WALLET_PROXY_WALLETS must be valid JSON.', 500);
  }

  if (!isRecord(parsed)) {
    throw new WalletProxyError('INVALID_WALLET_CONFIG', 'WALLET_PROXY_WALLETS must be a JSON object.', 500);
  }

  const wallets: WalletMap = {};
  for (const [alias, value] of Object.entries(parsed)) {
    wallets[alias] = normalizeWalletConfig(alias, value);
  }
  return wallets;
}

function getWalletConfig(env: Env, alias: string): WalletConfig {
  const wallets = parseWalletConfig(env.WALLET_PROXY_WALLETS ?? '{}');
  const wallet = wallets[alias];
  if (!wallet) {
    throw new WalletProxyError('WALLET_NOT_FOUND', `Unknown wallet alias: ${alias}`, 404);
  }
  return wallet;
}

function normalizeWalletConfig(alias: string, value: unknown): WalletConfig {
  if (!isRecord(value) || typeof value.provider !== 'string') {
    throw new WalletProxyError(
      'INVALID_WALLET_CONFIG',
      `Wallet alias ${alias} must include a provider.`,
      500,
    );
  }

  if (value.provider === 'privy') {
    if (typeof value.walletId !== 'string' || !value.walletId) {
      throw new WalletProxyError(
        'INVALID_WALLET_CONFIG',
        `Privy wallet alias ${alias} must include walletId.`,
        500,
      );
    }
    return {
      provider: 'privy',
      walletId: value.walletId,
      address: optionalString(value.address),
    };
  }

  if (value.provider === 'cdp') {
    const address = optionalString(value.address);
    const accountName = optionalString(value.accountName);
    if (!address && !accountName) {
      throw new WalletProxyError(
        'INVALID_WALLET_CONFIG',
        `CDP wallet alias ${alias} must include address or accountName.`,
        500,
      );
    }
    return { provider: 'cdp', address, accountName };
  }

  if (value.provider === 'para') {
    const address = optionalString(value.address);
    if (!address || !isAddress(address)) {
      throw new WalletProxyError(
        'INVALID_WALLET_CONFIG',
        `Para wallet alias ${alias} must include an EVM address.`,
        500,
      );
    }
    return {
      provider: 'para',
      email: optionalString(value.email),
      walletId: optionalString(value.walletId),
      address,
      userShareSecret: optionalString(value.userShareSecret),
    };
  }

  throw new WalletProxyError(
    'INVALID_WALLET_CONFIG',
    `Unsupported wallet provider for alias ${alias}: ${value.provider}`,
    500,
  );
}

export function aliasToSecretSuffix(alias: string): string {
  return alias
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function paraUserShareSecretName(alias: string, wallet: Pick<ParaWalletConfig, 'userShareSecret'>): string {
  return wallet.userShareSecret ?? `PARA_USER_SHARE_${aliasToSecretSuffix(alias)}`;
}

function providerCapabilities(provider: Provider): Record<string, boolean> {
  return {
    address: true,
    status: true,
    signMessage: true,
    signTypedData: true,
    signTransaction: true,
    exportPrivateKey: false,
    rawSecretReadback: false,
    providerPolicy: true,
    localPolicyEngine: false,
    hashSigning: provider !== 'para',
  };
}

async function getAddress(env: Env, wallet: WalletConfig): Promise<string> {
  if (wallet.provider === 'privy') return getPrivyAddress(env, wallet);
  if (wallet.provider === 'cdp') return getCdpAddress(env, wallet);
  return wallet.address;
}

async function getStatusAddress(env: Env, wallet: WalletConfig): Promise<string | null> {
  if (wallet.provider === 'privy' && wallet.address) return wallet.address;
  if (wallet.provider === 'cdp' && wallet.address) return wallet.address;
  if (wallet.provider === 'para') return wallet.address;
  return getAddress(env, wallet).catch(() => null);
}

async function signMessage(
  request: Request,
  env: Env,
  alias: string,
  wallet: WalletConfig,
): Promise<Response> {
  const body = await readJsonObject(request);
  const message = body.message;
  if (typeof message !== 'string') {
    throw new WalletProxyError('INVALID_REQUEST', 'sign-message requires a string message.', 400);
  }

  const signature = await callProvider(wallet.provider, async () => {
    if (wallet.provider === 'privy') return signPrivyMessage(env, wallet, message);
    if (wallet.provider === 'cdp') return signCdpMessage(env, wallet, message);
    return signParaMessage(env, alias, wallet, message);
  });

  return jsonResponse({ provider: wallet.provider, alias, signature });
}

async function signTypedData(
  request: Request,
  env: Env,
  alias: string,
  wallet: WalletConfig,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!isRecord(body.typedData)) {
    throw new WalletProxyError('INVALID_REQUEST', 'sign-typed-data requires typedData.', 400);
  }
  const typedData = body.typedData;

  const signature = await callProvider(wallet.provider, async () => {
    if (wallet.provider === 'privy') return signPrivyTypedData(env, wallet, typedData);
    if (wallet.provider === 'cdp') return signCdpTypedData(env, wallet, typedData);
    return signParaTypedData(env, alias, wallet, typedData);
  });

  return jsonResponse({ provider: wallet.provider, alias, signature });
}

async function signTransaction(
  request: Request,
  env: Env,
  alias: string,
  wallet: WalletConfig,
): Promise<Response> {
  const body = await readJsonObject(request);

  if (typeof body.hash === 'string') {
    const signature = await callProvider(wallet.provider, async () => {
      if (wallet.provider === 'privy') return signPrivyHash(env, wallet, body.hash as Hex);
      if (wallet.provider === 'cdp') return signCdpHash(env, wallet, body.hash as Hex);
      return signParaHash(env, alias, wallet, body.hash as Hex);
    });
    return jsonResponse({ provider: wallet.provider, alias, signature });
  }

  if (isRecord(body.transaction)) {
    const transaction = body.transaction;
    const signedTransaction = await callProvider(wallet.provider, async () => {
      if (wallet.provider === 'privy') return signPrivyTransaction(env, wallet, transaction, optionalString(body.caip2));
      if (wallet.provider === 'cdp') return signCdpTransaction(env, wallet, transaction);
      return signParaTransaction(env, alias, wallet, transaction);
    });
    return jsonResponse({ provider: wallet.provider, alias, signedTransaction });
  }

  throw new WalletProxyError(
    'INVALID_REQUEST',
    'sign-transaction requires either hash or transaction.',
    400,
  );
}

async function callProvider<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WalletProxyError) throw error;
    throw new WalletProxyError(
      'PROVIDER_ERROR',
      `${provider} provider error: ${errorMessage(error)}`,
      502,
    );
  }
}

async function getPrivyAddress(env: Env, wallet: PrivyWalletConfig): Promise<string> {
  const walletJson = await privyFetch(env, `/wallets/${encodeURIComponent(wallet.walletId)}`, {
    method: 'GET',
  });
  const address = extractAddress(walletJson);
  if (!address) {
    throw new WalletProxyError('PROVIDER_ERROR', 'Privy wallet response did not include an address.', 502);
  }
  return address;
}

async function signPrivyMessage(env: Env, wallet: PrivyWalletConfig, message: string): Promise<string> {
  const data = await privyRpc(env, wallet.walletId, 'personal_sign', {
    message: isHex(message) ? message : stringToHex(message),
    encoding: 'hex',
  });
  return extractSignature(data);
}

async function signPrivyTypedData(
  env: Env,
  wallet: PrivyWalletConfig,
  typedData: Record<string, unknown>,
): Promise<string> {
  const data = await privyRpc(env, wallet.walletId, 'eth_signTypedData_v4', {
    typed_data: {
      domain: typedData.domain ?? {},
      types: typedData.types ?? {},
      primary_type: typedData.primaryType ?? typedData.primary_type,
      message: typedData.message ?? {},
    },
  });
  return extractSignature(data);
}

async function signPrivyHash(env: Env, wallet: PrivyWalletConfig, hash: Hex): Promise<string> {
  if (!isHex(hash)) {
    throw new WalletProxyError('INVALID_REQUEST', 'hash must be a hex string.', 400);
  }
  const data = await privyRpc(env, wallet.walletId, 'secp256k1_sign', { hash });
  return extractSignature(data);
}

async function signPrivyTransaction(
  env: Env,
  wallet: PrivyWalletConfig,
  transaction: Record<string, unknown>,
  caip2?: string,
): Promise<string> {
  const data = await privyRpc(env, wallet.walletId, 'eth_signTransaction', { transaction }, caip2);
  return extractSignedTransaction(data);
}

async function privyRpc(
  env: Env,
  walletId: string,
  method: string,
  params: Record<string, unknown>,
  caip2?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { method, params };
  if (caip2) body.caip2 = caip2;
  return privyFetch(env, `/wallets/${encodeURIComponent(walletId)}/rpc`, {
    method: 'POST',
    body: JSON.stringify(body, jsonReplacer),
  });
}

async function privyFetch(env: Env, path: string, init: RequestInit): Promise<unknown> {
  const appId = requireSecret(env, 'PRIVY_APP_ID');
  const appSecret = requireSecret(env, 'PRIVY_APP_SECRET');
  const base = env.PRIVY_API_BASE || 'https://api.privy.io/v1';
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`,
      'privy-app-id': appId,
      'content-type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Privy request failed (${res.status}): ${await safeResponseText(res)}`);
  }
  return res.json();
}

async function getCdpAddress(env: Env, wallet: CdpWalletConfig): Promise<string> {
  if (wallet.address) return wallet.address;
  const account = await resolveCdpAccount(env, wallet);
  return String(account.address);
}

async function signCdpMessage(env: Env, wallet: CdpWalletConfig, message: string): Promise<string> {
  const account = await resolveCdpAccount(env, wallet);
  return String(await account.signMessage({ message }));
}

async function signCdpTypedData(
  env: Env,
  wallet: CdpWalletConfig,
  typedData: Record<string, unknown>,
): Promise<string> {
  const account = await resolveCdpAccount(env, wallet);
  return String(await account.signTypedData(typedData));
}

async function signCdpHash(env: Env, wallet: CdpWalletConfig, hash: Hex): Promise<string> {
  if (!isHex(hash)) {
    throw new WalletProxyError('INVALID_REQUEST', 'hash must be a hex string.', 400);
  }
  const account = await resolveCdpAccount(env, wallet);
  return String(await account.sign({ hash }));
}

async function signCdpTransaction(
  env: Env,
  wallet: CdpWalletConfig,
  transaction: Record<string, unknown>,
): Promise<string> {
  const account = await resolveCdpAccount(env, wallet);
  if (typeof account.signTransaction !== 'function') {
    throw new Error('CDP account does not support signTransaction in this runtime.');
  }
  return String(await account.signTransaction(transaction));
}

async function resolveCdpAccount(env: Env, wallet: CdpWalletConfig): Promise<any> {
  ensureCdpNodeVersionCompat();
  const cdp = new CdpClient({
    apiKeyId: requireSecret(env, 'CDP_API_KEY_ID'),
    apiKeySecret: requireSecret(env, 'CDP_API_KEY_SECRET'),
    walletSecret: requireSecret(env, 'CDP_WALLET_SECRET'),
  }) as any;

  if (wallet.address) {
    return cdp.evm.getAccount({ address: wallet.address as Address });
  }
  if (wallet.accountName) {
    return cdp.evm.getOrCreateAccount({ name: wallet.accountName });
  }
  throw new WalletProxyError('INVALID_WALLET_CONFIG', 'CDP wallet requires address or accountName.', 500);
}

function ensureCdpNodeVersionCompat(): void {
  const globalWithProcess = globalThis as any;
  globalWithProcess.process ??= {};
  globalWithProcess.process.versions ??= {};
  globalWithProcess.process.versions.node ??= '20.0.0';
  globalWithProcess.process.env ??= {};
}

async function signParaMessage(
  env: Env,
  alias: string,
  wallet: ParaWalletConfig,
  message: string,
): Promise<string> {
  const account = await resolveParaAccount(env, alias, wallet);
  return String(await account.signMessage({ message }));
}

async function signParaTypedData(
  env: Env,
  alias: string,
  wallet: ParaWalletConfig,
  typedData: Record<string, unknown>,
): Promise<string> {
  const account = await resolveParaAccount(env, alias, wallet);
  return String(await account.signTypedData(typedData as any));
}

async function signParaHash(
  env: Env,
  alias: string,
  wallet: ParaWalletConfig,
  hash: Hex,
): Promise<string> {
  if (!isHex(hash)) {
    throw new WalletProxyError('INVALID_REQUEST', 'hash must be a hex string.', 400);
  }
  const account = await resolveParaAccount(env, alias, wallet);
  if (typeof (account as any).sign !== 'function') {
    throw new Error('Para viem account does not support raw hash signing.');
  }
  return String(await (account as any).sign({ hash }));
}

async function signParaTransaction(
  env: Env,
  alias: string,
  wallet: ParaWalletConfig,
  transaction: Record<string, unknown>,
): Promise<string> {
  const account = await resolveParaAccount(env, alias, wallet);
  return String(await account.signTransaction(transaction as any));
}

async function resolveParaAccount(env: Env, alias: string, wallet: ParaWalletConfig): Promise<any> {
  const apiKey = requireSecret(env, 'PARA_API_KEY');
  const userShare = requireChunkableSecret(env, paraUserShareSecretName(alias, wallet));
  const envName = (env.PARA_ENV || 'BETA').toUpperCase();
  const paraEnvironment = (Environment as Record<string, unknown>)[envName] ?? Environment.BETA;
  const para = new Para(paraEnvironment as any, apiKey, {
    disableWebSockets: true,
    offloadMPCComputationURL: optionalString(env.PARA_OFFLOAD_MPC_COMPUTATION_URL),
  });

  await para.setUserShare(userShare);
  if (wallet.walletId) {
    await para.setCurrentWalletIds({ EVM: [wallet.walletId] });
  }

  return createParaViemAccount({
    para: para as any,
    address: wallet.address as Hex,
  });
}

function assertAuthorized(request: Request, env: Env): void {
  const token = optionalString(env.WALLET_PROXY_BEARER_TOKEN);
  if (!token) return;

  const authorization = request.headers.get('authorization');
  if (authorization !== `Bearer ${token}`) {
    throw new WalletProxyError('UNAUTHORIZED', 'Unauthorized', 401);
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new WalletProxyError('INVALID_REQUEST', 'Request body must be valid JSON.', 400);
  }

  if (!isRecord(parsed)) {
    throw new WalletProxyError('INVALID_REQUEST', 'Request body must be a JSON object.', 400);
  }
  return parsed;
}

function requireSecret(env: Env, name: string): string {
  const value = env[name];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new WalletProxyError('MISSING_SECRET', `Missing Worker secret: ${name}`, 500);
}

function requireChunkableSecret(env: Env, name: string): string {
  const direct = optionalString(env[name]);
  if (direct) return direct;

  const chunks: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const value = optionalString(env[`${name}_${i}`]);
    if (!value) break;
    chunks.push(value);
  }

  if (chunks.length > 0) return chunks.join('');
  throw new WalletProxyError('MISSING_SECRET', `Missing Worker secret: ${name}`, 500);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, jsonReplacer), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code: ErrorCode, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function toWalletProxyError(error: unknown): WalletProxyError {
  if (error instanceof WalletProxyError) return error;
  return new WalletProxyError('INTERNAL_ERROR', errorMessage(error), 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return response.statusText;
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function extractAddress(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.address === 'string') return value.address;
  if (isRecord(value.data) && typeof value.data.address === 'string') return value.data.address;
  if (isRecord(value.wallet) && typeof value.wallet.address === 'string') return value.wallet.address;
  return undefined;
}

function extractSignature(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value.signature === 'string') return value.signature;
    if (isRecord(value.data) && typeof value.data.signature === 'string') return value.data.signature;
  }
  throw new Error('Provider response did not include a signature.');
}

function extractSignedTransaction(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value.signedTransaction === 'string') return value.signedTransaction;
    if (typeof value.signed_transaction === 'string') return value.signed_transaction;
    if (isRecord(value.data)) return extractSignedTransaction(value.data);
  }
  throw new Error('Provider response did not include a signed transaction.');
}
