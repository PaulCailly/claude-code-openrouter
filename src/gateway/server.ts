import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateKey } from '../openrouter/auth.ts';
import { fromChat } from '../openrouter/chat.ts';
import { openrouterRequest } from '../openrouter/request.ts';
import { formatOpenRouterQuota, readOpenRouterQuota } from '../openrouter/usage.ts';
import type { AgentCatalog } from './agent-catalog.ts';
import { forAnthropic } from './anthropic.ts';
import type { GatewayFetch } from './fetch.ts';
import type { Emit, MessagesRequest, MessagesResponse, StopReason } from './messages.ts';
import { ModBridge } from './mod-bridge.ts';
import { ModCompactions } from './mod-compaction.ts';
import { handleModRoute } from './mod-routes.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import type { PendingApprovalTool } from './permission-hook.ts';
import { approvalCapabilityGuard } from './permission-hook.ts';
import { ProviderUsageDashboard } from './provider-usage.ts';
import { ReceiptLedger } from './receipts.ts';
import { estimateInputTokens } from './tokens.ts';
import { forwardObservedTools, ToolObserver } from './tool-observer.ts';
import { originalToolNames } from './tools.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com';
const MAX_BODY = 8 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-openrouter-gateway-token',
  'accept-encoding',
];
const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
];

/** What the gateway reports to `onEvent`; routing only, never credentials or bodies. */
export interface GatewayEvent {
  route: 'anthropic' | 'openrouter' | 'openrouter-request';
  model?: string;
  agentId?: string | null;
  path?: string;
  effort?: string;
  status?: number;
  stopReason?: StopReason | null;
  tools?: string[];
  stage?: 1 | 2;
  outcome?: 'allow' | 'deny';
  cached?: boolean;
  permissionContext?: PermissionContext;
  usage?: MessagesResponse['usage'];
  usageMetadata?: MessagesResponse['multi_usage'];
  requestId?: string;
  /** Upstream API the request was billed through, present on completion events. */
  endpoint?: string;
  /** Claude session that owns the request, when the client identified one. */
  session?: string;
}

export interface GatewayOptions {
  receipts?: ReceiptLedger;
  usageDashboard?: ProviderUsageDashboard;
  token: string;
  enabledProviders?: readonly string[];
  fetchImpl?: GatewayFetch;
  onEvent?: (event: GatewayEvent) => void;
  timeoutMs?: number;
  openrouter?: { apiKey: string };
  /** No Anthropic credentials: also block passthrough. */
  blockAnthropic?: boolean;
  guardAuto?: boolean;
  permissionModes?: PermissionModes;
  agentCatalog?: AgentCatalog;
  modBridge?: ModBridge;
}

/** Rejected before any provider call; answered as HTTP 400 rather than 502. */
class BadRequest extends Error {}
class UpstreamFailure extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, retryAfter: string | null, provider = 'OpenRouter') {
    super(
      `${provider} returned HTTP ${status}.${status === 401 ? ' Check the OpenRouter API key.' : ''}`,
    );
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authenticated(actual: string | string[] | undefined, expected: string): boolean {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

interface ProviderRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: MessagesRequest;
  parsed: Record<string, unknown>;
  raw: Buffer;
  url: URL;
  signal: AbortSignal;
  abort: AbortController;
  agentId?: string;
  identity: ReturnType<typeof requestIdentity>;
  permissionContext?: PermissionContext;
  emit: Emit;
  remember: (tool: { id: string; name: string; input: unknown }) => void;
  startStream: () => void;
}

export function createNativeGateway({
  token,
  enabledProviders,
  fetchImpl = fetch,
  onEvent: observer = () => {},
  timeoutMs,
  openrouter,
  blockAnthropic,
  guardAuto,
  permissionModes,
  agentCatalog,
  modBridge = new ModBridge(),
  receipts = new ReceiptLedger(),
  usageDashboard,
}: GatewayOptions): Server {
  const dashboard =
    usageDashboard ??
    new ProviderUsageDashboard({
      enabled: (enabledProviders ?? ['openrouter']).filter(() => Boolean(openrouter)),
      openrouter: openrouter
        ? async () =>
            formatOpenRouterQuota(await readOpenRouterQuota({ apiKey: openrouter.apiKey }))
        : undefined,
    });
  const onEvent = (event: GatewayEvent) => {
    receipts.observe(event);
    observer(event);
  };
  if (!token) {
    throw new Error('Gateway token required');
  }
  if (openrouter) {
    validateKey(openrouter.apiKey);
  }
  const fallbackSession = randomUUID();
  const pendingTools = new Map<string, PendingApprovalTool>();
  function permissionHook(parsed: Record<string, unknown>) {
    const id = typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : '';
    const pending = pendingTools.get(id);
    pendingTools.delete(id);
    return approvalCapabilityGuard(parsed, pending, !blockAnthropic);
  }
  const compactions = new ModCompactions(async () => {
    throw new Error('Precomputed summaries require a native harness model');
  });

  async function handleOpenRouter(exchange: ProviderRequest) {
    const { res, body, url, signal, agentId, emit } = exchange;
    if (!openrouter?.apiKey) {
      throw new BadRequest(
        'OpenRouter is not configured. Set OPENROUTER_API_KEY or connect OpenRouter.',
      );
    }
    const prepared = prepareOpenRouterRequest(exchange, fallbackSession);
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-openrouter-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: prepared.inputTokens }));
    }
    onEvent({ route: 'openrouter-request', agentId, model: body.model });
    const upstream = await fetchImpl(`https://opencode.ai/openrouter/v1/${prepared.endpoint}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openrouter.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-opencode-session': prepared.cacheKey,
        'x-opencode-client': 'cc-multi-cli-plugin',
      },
      body: JSON.stringify(prepared.body),
      signal,
      redirect: 'error',
    });
    if (!upstream.ok) {
      onEvent({ route: 'openrouter', agentId, status: upstream.status });
      await upstream.body?.cancel();
      throw new UpstreamFailure(upstream.status, upstream.headers.get('retry-after'), 'OpenRouter');
    }
    if (!upstream.body) {
      throw new Error('OpenRouter returned no response stream.');
    }
    exchange.startStream();
    const options = {
      toolNames: originalToolNames(body),
      stopSequences: body.stop_sequences,
      signaturePrefix: prepared.signaturePrefix,
      requireUsage: true,
      inputTokens: prepared.inputTokens,
    };
    const result = await fromChat(
      upstream.body,
      String(body.model),
      body.stream ? emit : undefined,
      options,
    );
    rememberResult(exchange, result);
    if (result.stop_reason === 'stop_sequence') {
      exchange.abort.abort();
    }
    onEvent(completionEvent(exchange, result, 'openrouter', prepared.endpoint));
    sendResult(exchange, result);
  }
  async function handleAnthropic(exchange: ProviderRequest) {
    const { req, res, body, url, raw, signal } = exchange;
    const headers = anthropicHeaders(req);
    const cleaned = forAnthropic(body);
    let forwarded: Buffer | undefined;
    if (req.method === 'POST') {
      forwarded = cleaned === body ? raw : Buffer.from(JSON.stringify(cleaned));
    }
    const upstream = await fetchImpl(ANTHROPIC_URL + url.pathname + url.search, {
      method: req.method ?? 'GET',
      headers,
      body: forwarded,
      signal,
      redirect: 'error',
    });
    onEvent({ route: 'anthropic', status: upstream.status, model: body.model });
    const responseHeaders = Object.fromEntries(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      delete responseHeaders[name];
    }
    res.writeHead(upstream.status, responseHeaders);
    if (guardAuto && upstream.ok && body.tools?.length) {
      await forwardObservedTools(upstream, res, exchange.remember, signal);
    } else if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  }
  async function sendPermissionDecision({ req, res, parsed }: ProviderRequest) {
    if (req.method !== 'POST') {
      throw new BadRequest('Permission hook requires POST');
    }
    const decision = permissionHook(parsed);
    if (
      permissionModes &&
      typeof parsed.session_id === 'string' &&
      typeof parsed.cwd === 'string' &&
      path.isAbsolute(parsed.cwd)
    ) {
      await permissionModes.recoverPolicy(parsed.session_id, parsed.cwd, parsed.permission_mode);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(decision));
  }
  async function dispatch(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
    external: string | null,
  ) {
    if (!external && blockAnthropic) {
      throw new BadRequest('Anthropic is not signed in. Select an external model.');
    }
    return forwardProvider(exchange, external);
  }
  function completionEvent(
    exchange: ProviderRequest,
    result: MessagesResponse,
    route: GatewayEvent['route'],
    endpoint: string,
  ): GatewayEvent {
    return {
      route,
      endpoint,
      session: exchange.identity.session || fallbackSession,
      agentId: exchange.agentId,
      model: result.multi_usage?.model ?? exchange.body.model,
      effort: result.multi_usage?.effort ?? exchange.body.output_config?.effort,
      stopReason: result.stop_reason,
      tools: result.content.filter((block) => block.type === 'tool_use').map((block) => block.name),
      usage: result.usage,
      usageMetadata: result.multi_usage ?? { source: 'unavailable' },
      requestId: JSON.stringify([
        route,
        exchange.identity.session || fallbackSession,
        exchange.agentId,
        result.id,
      ]),
    };
  }
  function beginUsage(exchange: ProviderRequest, external: string | null) {
    if (external && exchange.url.pathname === '/v1/messages') {
      receipts.start({
        session: exchange.identity.session || fallbackSession,
        agentId: exchange.agentId,
      });
    }
  }
  async function forwardProvider(exchange: ProviderRequest, external: string | null) {
    const { body, agentId, url } = exchange;
    const route = providerRoute(external);
    beginUsage(exchange, external);
    const permissionContext: PermissionContext | undefined = undefined;
    onEvent({
      route,
      model: body.model,
      agentId: agentId ?? null,
      path: url.pathname,
      permissionContext,
    });
    if (!external) {
      return handleAnthropic(exchange);
    }
    return handleOpenRouter(exchange);
  }
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    let heartbeat: NodeJS.Timeout | undefined;
    let sourceModel = '';
    let sourceSession = '';
    let sourceScope: string | undefined;
    const observer = new ToolObserver((tool) => remember(tool));
    const remember = (tool: { id: string; name: string; input: unknown }) => {
      if (!guardAuto || !sourceSession) {
        return;
      }
      evictOldest(pendingTools, 512);
      pendingTools.set(tool.id, {
        model: sourceModel,
        session: sourceSession,
        name: tool.name,
        input: tool.input,
        scope: sourceScope,
      });
    };
    const emit: Emit = (type, value) => {
      if (guardAuto) {
        observer.event({ type, ...value });
      }
      return res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    };
    try {
      if (!authorizeRequest(req, res, token, guardAuto)) {
        return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const { raw, parsed, body } = await readRequest(req, agentCatalog);
      if (url.pathname.startsWith('/openrouter/mod/')) {
        return handleModRoute(
          req,
          res,
          url,
          parsed,
          modBridge,
          permissionModes,
          compactions,
          receipts,
          undefined,
          dashboard,
        );
      }
      const external = externalModel(body.model);
      assertProviderEnabled(external, enabledProviders);
      const signal = providerSignal(abort.signal, external, timeoutMs);
      const agentId = header(req.headers['x-claude-code-agent-id']);
      const metadata = requestIdentity(
        parsed,
        agentId,
        header(req.headers['x-claude-code-session-id']),
      );
      sourceModel = String(body.model ?? '');
      sourceSession = metadata.session;
      sourceScope = metadata.scope;
      const exchange: ProviderRequest = {
        req,
        res,
        body,
        parsed,
        identity: metadata,
        raw,
        url,
        signal,
        abort,
        agentId,
        emit,
        remember,
        startStream: () => {
          if (!body.stream) {
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders();
          heartbeat = setInterval(() => emit('ping', {}), 15000);
        },
      };
      if (url.pathname === '/openrouter/permission') {
        return sendPermissionDecision(exchange);
      }
      await dispatch(exchange, metadata, external);
    } catch (error) {
      abort.abort();
      failResponse(res, emit, error);
    } finally {
      clearInterval(heartbeat);
    }
  });
}

class RequestTooLarge extends Error {}

function providerSignal(disconnected: AbortSignal, model: string | null, timeoutMs?: number) {
  // Direct provider runs follow the client connection rather than an HTTP deadline.
  if (model?.startsWith('openrouter/') && timeoutMs === undefined) {
    return disconnected;
  }
  return AbortSignal.any([disconnected, AbortSignal.timeout(timeoutMs ?? 180000)]);
}

async function readRequest(req: http.IncomingMessage, catalog?: AgentCatalog) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > (req.url?.startsWith('/openrouter/mod/') ? 32 * 1024 : MAX_BODY)) {
      throw new RequestTooLarge();
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new BadRequest('Invalid JSON');
  }
  if (!isRecord(parsed) || (parsed.model !== undefined && typeof parsed.model !== 'string')) {
    throw new BadRequest('Expected an object with a string model');
  }
  const body: MessagesRequest = catalog?.compact(parsed) ?? parsed;
  return { raw: body === parsed ? raw : Buffer.from(JSON.stringify(body)), parsed, body };
}

function providerRoute(model: string | null): 'anthropic' | 'openrouter' {
  return model?.startsWith('openrouter/') ? 'openrouter' : 'anthropic';
}
function errorStatus(error: unknown): number {
  if (error instanceof BadRequest) {
    return 400;
  }
  if (error instanceof UpstreamFailure) {
    return error.status;
  }
  return 502;
}

function rememberResult(exchange: ProviderRequest, result: MessagesResponse) {
  if (exchange.body.stream) {
    return;
  }
  for (const tool of result.content) {
    if (tool.type === 'tool_use') {
      exchange.remember(tool);
    }
  }
}
function sendResult(exchange: ProviderRequest, result: MessagesResponse) {
  if (!exchange.body.stream) {
    exchange.res.writeHead(200, { 'content-type': 'application/json' });
  }
  exchange.res.end(exchange.body.stream ? undefined : JSON.stringify(result));
}

function evictOldest<T>(cache: Map<string, T>, capacity: number) {
  const oldest = cache.keys().next();
  if (cache.size >= capacity && !oldest.done) {
    cache.delete(oldest.value);
  }
}

function requestIdentity(
  parsed: Record<string, unknown>,
  agentId?: string,
  sessionHeader?: string,
) {
  const rawIdentity =
    isRecord(parsed.metadata) && typeof parsed.metadata.user_id === 'string'
      ? parsed.metadata.user_id
      : undefined;
  let session = '';
  if (rawIdentity) {
    try {
      const metadata: unknown = JSON.parse(rawIdentity);
      if (isRecord(metadata) && typeof metadata.session_id === 'string') {
        session = metadata.session_id;
      }
    } catch {
      /* Unknown identity cannot grant auto capability. */
    }
  }
  if (session && sessionHeader && session !== sessionHeader) {
    throw new BadRequest('Session header and metadata disagree');
  }
  session = session || sessionHeader || '';
  const identity = session || rawIdentity;
  return {
    identity,
    session,
    scope: identity ? JSON.stringify([identity, agentId ?? 'main']) : undefined,
  };
}

function prepareOpenRouterRequest(exchange: ProviderRequest, fallbackSession: string) {
  const { req, body, url, identity, agentId } = exchange;
  try {
    if (
      req.method !== 'POST' ||
      !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)
    ) {
      throw new Error('OpenRouter requires POST /v1/messages or /v1/messages/count_tokens');
    }
    // OpenRouter uses this for sticky upstream routing. Claude identity survives restarts;
    // no per-request nonce is inserted into the prompt or cache key.
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify([
          identity.session || fallbackSession,
          agentId ?? 'main',
          body.model,
          process.cwd(),
        ]),
      )
      .digest('hex');
    return { ...openrouterRequest(body, cacheKey), cacheKey };
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}

function anthropicHeaders(req: http.IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const single = header(value);
    if (single !== undefined && !STRIPPED_REQUEST_HEADERS.includes(name)) {
      headers[name] = single;
    }
  }
  headers['accept-encoding'] = 'identity';
  return headers;
}

function authorizeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  guardAuto?: boolean,
) {
  if (req.headers.origin || !authenticated(req.headers['x-openrouter-gateway-token'], token)) {
    const pathName = new URL(req.url ?? '', 'http://localhost').pathname;
    res.writeHead(pathName.startsWith('/openrouter/mod/') ? 401 : 403);
    res.end('Forbidden');
    return false;
  }
  const url = new URL(req.url ?? '', 'http://localhost');
  if (
    ![
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1/models',
      '/api/hello',
      '/openrouter/mod/session',
      '/openrouter/mod/worker',
      '/openrouter/mod/mode',
      '/openrouter/mod/policy',
      '/openrouter/mod/offer',
      '/openrouter/mod/telemetry',
      '/openrouter/mod/lifecycle',
      '/openrouter/mod/usage',
      '/openrouter/mod/usage/complete',
      '/openrouter/mod/receipts',
      '/openrouter/mod/detach',
      '/openrouter/mod/compact/precompute',
      '/openrouter/mod/compact/run',
      '/openrouter/mod/compact/authorize',
      '/openrouter/mod/compact/cancel',
      ...(guardAuto ? ['/openrouter/permission'] : []),
    ].includes(url.pathname) ||
    !['POST', 'GET', 'HEAD'].includes(req.method ?? '')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return false;
  }
  return true;
}

function failResponse(res: http.ServerResponse, emit: Emit, error: unknown) {
  if (res.destroyed) {
    return;
  }
  const status = errorStatus(error);
  if (error instanceof RequestTooLarge) {
    res.writeHead(413);
    res.end('Request too large');
    return;
  }
  const errorTypes: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    503: 'overloaded_error',
  };
  const failure = {
    type: 'error',
    error: {
      type: errorTypes[status] ?? 'api_error',
      message: `Native gateway: ${reason(error)}`,
    },
  };
  if (error instanceof UpstreamFailure && error.retryAfter && !res.headersSent) {
    res.setHeader('retry-after', error.retryAfter);
  }
  if (res.headersSent) {
    emit('error', { error: failure.error });
    res.end();
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure));
  }
}

function assertProviderEnabled(model: string | null, enabled: readonly string[] | undefined) {
  if (model && enabled && !enabled.includes('openrouter')) {
    throw new BadRequest('This provider plugin is not enabled for this session.');
  }
}

function externalModel(model: unknown) {
  return typeof model === 'string' && model.startsWith('openrouter/') ? model : null;
}
