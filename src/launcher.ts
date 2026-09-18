#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentCatalog } from './gateway/agent-catalog.ts';
import {
  loadWorkerPermissions,
  type PluginPermissionInventory,
  pluginPermissions,
} from './gateway/agent-definitions.ts';
import type { Effort } from './gateway/effort.ts';
import { executableInvocation, resolveExecutable } from './gateway/executable.ts';
import { ModBridge } from './gateway/mod-bridge.ts';
import { PermissionModes } from './gateway/mode-hook.ts';
import { hookCommand } from './gateway/permission-hook.ts';
import { ReceiptLedger } from './gateway/receipts.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';
import { providerSelection } from './install/plugins.ts';
import { readOpenRouterKey } from './openrouter/auth.ts';
import { loadCatalog } from './openrouter/catalog.ts';
import type { ModelOption as OpenRouterOption } from './openrouter/models.ts';
import { workerDefinitions as openrouterWorkers, pickerOptions } from './openrouter/models.ts';

const enabledProviders = providerSelection(process.env.OPENROUTER_ENABLED_PROVIDERS);
const providerEnabled = (provider: string) =>
  enabledProviders?.some((name) => name === provider) ?? true;
const claudeExecutable = process.env.OPENROUTER_REAL_CLAUDE;

/**
 * Claude Code requires a non-empty subagent prompt. Workers get no behavioral rules here;
 * provider profiles and Claude's native subagent prompt govern them.
 */
const WORKER_PROMPT = 'Complete the delegated task.';

/** One `--agents` entry: an external worker using Claude Code's native tools. */
interface AgentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools: string[];
  effort?: Effort;
}

/** One `/model` entry the launched session offers. */
interface ModelOption {
  behavesAs?: string;
  model: string;
  label: string;
  description: string;
}

interface LaunchSettings {
  modelPicker: { options: ModelOption[] };
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  await handleCommand(args[0]);
  if (args[0] === '--') {
    args.shift();
  }
  validateSessionLaunch(args);
  const pluginInventory = await pluginPermissions(process.cwd(), args);
  const pluginRoot = await findPluginRoot(fileURLToPath(import.meta.url));
  await assertFunctionHooksSupported();
  const anthropic = await anthropicSignedIn();
  const apiKey = providerEnabled('openrouter') ? await readOpenRouterKey() : undefined;
  const catalog = apiKey ? await discoverCatalog() : undefined;
  const rows = catalog ? pickerOptions(catalog.models, process.env.OPENROUTER_MODELS) : [];
  const token = randomBytes(32).toString('hex');
  const settings = pickerSettings(rows);
  await mergeSettings(args, settings);
  // The supervisor does not transfer --agents or our session-local gateway env,
  // and can outlive the child whose exit releases settingsDir and the gateway.
  // Keep ordinary background subagent tasks available within this owned session.
  settings.disableAgentView = true;
  const callerSettings = structuredClone(settings);
  const agents = workerDefinitions(rows);
  const modBridge = new ModBridge();
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'openrouter-settings-'));
  const callerSettingsFile = path.join(settingsDir, 'caller-settings.json');
  await writeFile(callerSettingsFile, JSON.stringify(callerSettings), { mode: 0o600 });
  const permissionModes = new PermissionModes(
    (cwd) =>
      loadWorkerPermissions(
        cwd,
        agents,
        [...args, '--settings', callerSettingsFile],
        pluginInventory,
      ),
    async () => ({}),
  );
  await permissionModes.precompute(process.cwd());
  const receipts = new ReceiptLedger({
    file: process.env.OPENROUTER_RECEIPTS_FILE
      ? path.resolve(process.env.OPENROUTER_RECEIPTS_FILE)
      : undefined,
    onError: (error) => {
      process.stderr.write(`[native] receipt not written: ${String(error)}\n`);
    },
  });
  const server = createNativeGateway({
    receipts,
    token,
    enabledProviders,
    modBridge,
    openrouter:
      apiKey && catalog
        ? { apiKey, models: catalog.models, providerJson: process.env.OPENROUTER_PROVIDER }
        : undefined,
    permissionModes,
    blockAnthropic: !anthropic,
    guardAuto: true,
    agentCatalog: new AgentCatalog(
      agents,
      settings.modelPicker.options.map((option) => option.model),
    ),
    onEvent: traceEvent,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not bind a local port.');
  }
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { initialModel, selectedModel } = await initialSelection(args, settings, anthropic);
  if (!initialModel && selectedModel) {
    args.push('--model', selectedModel);
  }
  configureApproval(settings, anthropic);
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  const childEnvironment = gatewayEnvironment(address.port, token, anthropic);
  const claudePath = resolveExecutable('claude', {
    configuredPath: claudeExecutable,
    env: childEnvironment,
  });
  const childArguments = launcherArguments(
    args,
    settingsFile,
    definitions,
    pluginInventory,
    pluginRoot,
  );
  const childInvocation = executableInvocation(
    claudePath,
    childArguments,
    process.platform,
    childEnvironment,
  );
  try {
    checkLauncherArgumentLimit(agents, childInvocation, claudePath, process.platform);
  } catch (error) {
    server.close();
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
    throw error;
  }
  const ready = awaitModSessionStart();
  const child = spawn(childInvocation.command, childInvocation.args, {
    stdio: 'inherit',
    env: childEnvironment,
    detached: process.platform !== 'win32',
    ...childInvocation.options,
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
  };
  try {
    await ready;
  } catch (error) {
    child.kill();
    await shutdown();
    throw error;
  }
  child.once('error', (error) => {
    console.error(error.message);
    void shutdown().finally(() => process.exit(1));
  });
  child.once('exit', (code) => {
    void shutdown().finally(() => process.exit(code ?? 1));
  });
  if (process.platform === 'win32') {
    // Windows console control events do not provide POSIX process groups. Claude's
    // child owns Ctrl+C handling; forward termination explicitly to its process tree.
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => {});
  } else {
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    // Unix foreground terminals deliver SIGINT to both processes; Claude owns its
    // interrupt UI, so the gateway deliberately remains alive.
    process.on('SIGINT', () => {});
  }
}

/**
 * Claude's plugin cache may be a symlink to a checkout. Node resolves the entry
 * module to its real path, so compare real paths rather than the argv spelling.
 */
function isEntryModule(argument: string | undefined): boolean {
  if (!argument) {
    return false;
  }
  const entry = fileURLToPath(import.meta.url);
  const resolved = path.resolve(argument);
  if (resolved === entry) {
    return true;
  }
  try {
    return realpathSync(resolved) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1])) {
  void main().catch((error) => {
    console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

function validateSessionLaunch(args: string[]) {
  if (
    args.some((arg) => arg === '--bg' || arg === '--background') ||
    ['attach', 'respawn'].includes(args[0] ?? '')
  ) {
    throw new Error(
      'OpenRouter sessions must stay attached to their launcher. Exit and use --resume <session-id> to continue with a fresh gateway; whole-session background handoff is unsupported.',
    );
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    throw new Error(
      'Start without ANTHROPIC_BASE_URL; this launcher supplies the central gateway.',
    );
  }
  if (args.some((arg) => arg === '--agents' || arg.startsWith('--agents='))) {
    throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failedAuthProbeOutput(error: unknown): string {
  const details = recordValue(error);
  const code = details?.code;
  const stdout = details?.stdout;
  if (code === 1 && typeof stdout === 'string') {
    return stdout;
  }
  throw new Error('Claude auth status probe failed; cannot determine login state');
}

function parseAuthProbeOutput(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Claude auth status probe returned invalid JSON');
  }
  const details = recordValue(parsed);
  if (!details || typeof details.loggedIn !== 'boolean') {
    throw new Error('Claude auth status probe returned no boolean loggedIn field');
  }
  return details.loggedIn;
}

async function assertFunctionHooksSupported(): Promise<void> {
  let stdout: string;
  let executable = 'claude';
  try {
    executable = resolveExecutable('claude', {
      platform: process.platform,
      env: process.env,
      configuredPath: claudeExecutable,
    });
    const invocation = executableInvocation(
      executable,
      ['--version'],
      process.platform,
      process.env,
    );
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    const details = recordValue(error);
    const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
    const firstLine = String(error).split('\n', 1)[0];
    throw new Error(
      `Claude Code 2.1.272 or newer with function hooks is required; unable to read ${executable} --version${code}: ${firstLine}.`,
      { cause: error },
    );
  }
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match || !atLeastVersion(match.slice(1).map(Number), [2, 1, 272])) {
    throw new Error('Claude Code 2.1.272 or newer with function hooks is required.');
  }
}

function claudeCommand(args: readonly string[]) {
  const environment = process.env;
  return executableInvocation(
    resolveExecutable('claude', {
      platform: process.platform,
      env: environment,
      configuredPath: claudeExecutable,
    }),
    args,
    process.platform,
    environment,
  );
}

function atLeastVersion(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index++) {
    const received = actual[index] ?? 0;
    const minimum = required[index] ?? 0;
    if (received !== minimum) {
      return received > minimum;
    }
  }
  return true;
}

/**
 * Claude Code has to start, load the plugin worker and run session.start before
 * the mod can acknowledge. A cold start on Windows takes well over five seconds
 * (large binary, antivirus scan), so the wait is generous and overridable.
 */
const modSessionStartTimeoutMs = Number(process.env.OPENROUTER_MOD_START_TIMEOUT_MS ?? 30000);

function awaitModSessionStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('openrouter-mod-session-start', ready);
      reject(
        new Error(
          'Claude Code 2.1.272 or newer with loaded function hooks is required; the openrouter mod did not acknowledge session.start.',
        ),
      );
    }, modSessionStartTimeoutMs);
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once('openrouter-mod-session-start', ready);
  });
}

async function anthropicSignedIn(): Promise<boolean> {
  // Ask Claude, including its OS credential store and configured helpers. Never read its tokens.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  let stdout: string;
  try {
    const invocation = claudeCommand(['auth', 'status', '--json']);
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    stdout = failedAuthProbeOutput(error);
  }
  return parseAuthProbeOutput(stdout);
}

export function workerDefinitions(rows: readonly OpenRouterOption[]) {
  const agents: Record<string, AgentDefinition> = {};
  for (const [name, option] of Object.entries(openrouterWorkers(rows))) {
    agents[name] = {
      description: `OpenRouter ${option.model.replace('openrouter/', '')}${option.effort ? `, ${option.effort} effort` : ''}. Uses native Claude Code tools.`,
      prompt: WORKER_PROMPT,
      model: option.model,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
      ...(option.effort ? { effort: option.effort } : {}),
    };
  }
  return agents;
}

interface LauncherInvocation {
  command: string;
  args: readonly string[];
  viaComSpec?: boolean;
}

export function checkLauncherArgumentLimit(
  agents: Record<string, AgentDefinition>,
  invocation: LauncherInvocation,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    return;
  }
  const viaComSpec = invocation.viaComSpec ?? /(?:^|[\\/])cmd\.exe$/i.test(invocation.command);
  const limit = viaComSpec ? 8000 : 32000;
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (commandLine.length <= limit) {
    return;
  }
  const providers = new Map<string, number>();
  for (const [name, agent] of Object.entries(agents)) {
    const provider = agent.model.split('/')[1] ?? 'unknown';
    providers.set(
      provider,
      (providers.get(provider) ?? 0) + Buffer.byteLength(JSON.stringify({ [name]: agent })),
    );
  }
  const largest = [...providers.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([provider, bytes]) => `${provider} (${bytes} B)`)
    .join(', ');
  const shim = viaComSpec ? ' cmd.exe shim' : '';
  throw new Error(
    `Native worker registration needs ${commandLine.length.toLocaleString()} characters for ${executable}, above the Windows${shim} limit of ${limit.toLocaleString()}. Largest providers: ${largest || 'none'}. Disable providers or extra models to reduce the launcher arguments.`,
  );
}

async function mergeSettings(args: string[], settings: LaunchSettings) {
  // Keep one --settings argument, preserving explicit caller settings and our picker.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) {
      continue;
    }
    const inline = args[i].startsWith('--settings=');
    const value = inline ? args[i].slice(11) : args[i + 1];
    if (!value) {
      throw new Error('--settings requires a JSON object or file');
    }
    const extra = await readSettings(value);
    const picker = settings.modelPicker;
    Object.assign(settings, extra);
    settings.modelPicker = {
      ...picker,
      ...extra.modelPicker,
      options: [...picker.options, ...(extra.modelPicker?.options ?? [])],
    };
    args.splice(i, inline ? 1 : 2);
    i--;
  }
}

async function initialSelection(args: string[], settings: LaunchSettings, anthropic: boolean) {
  const savedModel = await savedSelection(args);
  let initialModel =
    process.env.ANTHROPIC_MODEL ??
    (typeof settings.model === 'string' ? settings.model : savedModel);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      initialModel = args[++i];
    } else if (args[i].startsWith('--model=')) {
      initialModel = args[i].slice(8);
    }
  }
  // With no Claude login, start on an available external model instead of Sonnet.
  const options = settings.modelPicker.options;
  const fallback = anthropic ? undefined : options[0]?.model;
  return { initialModel, selectedModel: initialModel ?? fallback };
}

function configureApproval(settings: LaunchSettings, anthropic = false) {
  // Claude executes every tool here, so auto mode needs Claude's own review.
  if (!anthropic) {
    settings.permissions = { ...settings.permissions, disableAutoMode: 'disable' };
  }
  // --settings is fixed for the session. A per-tool capability guard also covers
  // /model changes and workers, without calling a model or classifying commands.
  const command = hookCommand(new URL('./gateway/permission-hook.ts', import.meta.url));
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  settings.hooks = {
    ...hooks,
    PreToolUse: [
      ...(hooks?.PreToolUse ?? []),
      { hooks: [{ type: 'command', command, timeout: 10 }] },
    ],
  };
}

async function handleCommand(command?: string) {
  if (command === '--openrouter-models') {
    console.log(JSON.stringify((await loadCatalog()).models, null, 2));
    process.exit(0);
  }
  if (command === '--help') {
    console.log(
      'Usage: node src/launcher.ts [--openrouter-models] [-- <claude arguments>]\nLaunch Claude with OpenRouter models and named workers.\n--openrouter-models: list the admitted OpenRouter models and capabilities\nOPENROUTER_API_KEY: the API key (or run claude-openrouter connect)\nOPENROUTER_MODELS: comma-separated OpenRouter model IDs to show in /model (unset: defaults; empty: hide OpenRouter rows)',
    );
    process.exit(0);
  }
}

async function readSettings(value: string) {
  const extra = JSON.parse(
    value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'),
  );
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Invalid --settings object');
  }
  return extra;
}

async function savedSelection(args: string[]) {
  let savedModel: string | undefined;
  const sourcesIndex = args.lastIndexOf('--setting-sources');
  const sources = (
    args.findLast((arg) => arg.startsWith('--setting-sources='))?.slice(18) ??
    (sourcesIndex >= 0 ? args[sourcesIndex + 1] : 'user,project,local')
  ).split(',');
  for (const [source, filename] of [
    [
      'user',
      path.join(
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        'settings.json',
      ),
    ],
    ['project', path.join(process.cwd(), '.claude', 'settings.json')],
    ['local', path.join(process.cwd(), '.claude', 'settings.local.json')],
  ] as const) {
    if (!sources.includes(source)) {
      continue;
    }
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof value.model === 'string') {
        savedModel = value.model;
      }
    } catch {
      /* Claude handles missing or invalid native settings itself. */
    }
  }
  return savedModel;
}

/** Client compatibility only, not provider equivalence. Both profiles default to 200K
 * in Claude 2.1.267; newer xhigh profiles imply native 1M and are deliberately not used.
 * Provider validation remains authoritative for every requested effort value. */
function pickerProfile(adjustableEffort: boolean): string {
  return adjustableEffort ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
}

function pickerSettings(rows: readonly OpenRouterOption[]) {
  const settings: LaunchSettings = {
    modelPicker: {
      options: rows.map(({ model, label, description, catalog }) => ({
        model,
        label: `OpenRouter · ${label}`,
        behavesAs: pickerProfile(catalog.reasoning),
        description,
      })),
    },
  };
  return settings;
}

/** A cached catalog keeps a session usable during an OpenRouter outage. */
async function discoverCatalog() {
  const catalog = await loadCatalog();
  if (catalog.source === 'cache') {
    console.error(`Using the cached OpenRouter catalog from ${catalog.fetchedAt}.`);
  }
  return catalog;
}

/**
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also blocks the plugin worker's
 * loopback call to this gateway, which the Mods control plane requires. Keep
 * the user's intent (no updater, telemetry or error reports) with the narrower
 * flags instead of silently running without the mod.
 */
function translateTrafficPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    return env;
  }
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _flag, ...rest } = env;
  process.stderr.write(
    'claude-openrouter: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC would block the local gateway; using DISABLE_AUTOUPDATER, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING and DISABLE_BUG_COMMAND instead.\n',
  );
  return {
    ...rest,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
  };
}

function gatewayEnvironment(port: number, token: string, anthropic: boolean) {
  const env = translateTrafficPolicy({ ...process.env });
  delete env.OPENROUTER_API_KEY;
  return {
    ...env,
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    // Native runs and extended OpenAI reasoning can outlive Claude's default
    // API timer; preserve explicit user limits.
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ?? '2147483647',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    OPENROUTER_GATEWAY_TOKEN: token,
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    OPENROUTER_MOD_GATEWAY_URL: `http://127.0.0.1:${port}`,
    ...(!anthropic ? { ANTHROPIC_AUTH_TOKEN: token } : {}),
    ANTHROPIC_CUSTOM_HEADERS: [
      process.env.ANTHROPIC_CUSTOM_HEADERS,
      `x-openrouter-gateway-token: ${token}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function traceEvent(event: GatewayEvent) {
  if (process.env.OPENROUTER_NATIVE_TRACE === '1') {
    process.stderr.write(`[native] ${JSON.stringify(event)}\n`);
  }
}

async function findPluginRoot(file: string): Promise<string> {
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    try {
      await stat(path.join(directory, '.claude-plugin', 'plugin.json'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(`Could not find the openrouter plugin root above ${file}`);
      }
    }
  }
}

function hasPluginDirectory(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--plugin-dir' || arg.startsWith('--plugin-dir='));
}

function launcherArguments(
  args: readonly string[],
  settingsFile: string,
  definitions: string,
  inventory: PluginPermissionInventory,
  pluginRoot: string,
): string[] {
  const pluginDirectory =
    !hasPluginDirectory(args) && (!inventory.multiCoreEnabled || hasEmptySettingSources(args))
      ? ['--plugin-dir', pluginRoot]
      : [];
  return ['--settings', settingsFile, '--agents', definitions, ...args, ...pluginDirectory];
}

function hasEmptySettingSources(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--setting-sources' && args[index + 1] === '') {
      return true;
    }
    if (arg === '--setting-sources=') {
      return true;
    }
  }
  return false;
}
