import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkLauncherArgumentLimit, workerDefinitions } from '../../src/launcher.ts';
import { parseCatalog } from '../../src/openrouter/catalog.ts';
import { pickerOptions } from '../../src/openrouter/models.ts';

const catalogFixture = fileURLToPath(new URL('../fixtures/models.json', import.meta.url));
const catalogPayload: unknown = JSON.parse(await readFile(catalogFixture, 'utf8'));

async function writeClaudeFixture(bin: string, source: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'claude-fixture.js'), source);
    await writeFile(
      path.join(bin, 'claude.cmd'),
      // npm's global shim layout, so the launcher runs the fixture through Node directly.
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\claude-fixture.js" %*\r\n`,
    );
    return;
  }
  await writeFile(path.join(bin, 'claude'), source, { mode: 0o755 });
}

/** Windows reads the profile and data roots from these, not from HOME. */
function windowsHome(root: string): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    return {};
  }
  return {
    USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
  };
}

test('launcher preserves native auth, keeps Claude-reviewed auto mode, and merges caller settings', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'bin'));
  await writeClaudeFixture(
    path.join(cwd, 'bin'),
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log(process.env.TEST_PLUGIN==='enabled'?JSON.stringify([{id:'openrouter@claude-code-openrouter',enabled:true,installPath:process.cwd()}]):'[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.OPENROUTER_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/openrouter/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-openrouter-gateway-token':process.env.OPENROUTER_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){if(process.env.TEST_AUTH==='malformed'){console.log('not-json');process.exit(0)}if(process.env.TEST_AUTH==='error'){process.exit(2)}if(process.env.TEST_AUTH==='missing'){console.log('{}');process.exit(0)}process.stdout.write(JSON.stringify({loggedIn:process.env.TEST_AUTH==='yes'}));process.exitCode=process.env.TEST_AUTH==='yes'?0:1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
 result(JSON.stringify({agentView:process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW,backgroundTasks:process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,functionHooks:process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS,settings,models:args.filter(x=>x.startsWith('openrouter/')),args,settingsCount:args.filter(x=>x==='--settings').length,hasLocalToken:!!process.env.OPENROUTER_GATEWAY_TOKEN,apiTimeout:process.env.API_TIMEOUT_MS,auth:process.env.ANTHROPIC_API_KEY?'api':process.env.ANTHROPIC_AUTH_TOKEN?'local':'native'}));}
`,
  );
  const launcher = fileURLToPath(new URL('../../src/launcher.ts', import.meta.url));
  for (const auth of ['no', 'yes', 'api']) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        launcher,
        '--',
        '--model',
        'openrouter/glm-5.3',
        '--settings',
        JSON.stringify({
          disableAgentView: false,
          permissions: { deny: ['Bash(denied)'] },
          hooks: { Stop: [] },
        }),
      ],
      {
        cwd,
        timeout: 20000,
        env: {
          PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
          HOME: cwd,
          ...windowsHome(cwd),
          CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
          CODEX_HOME: cwd,
          TEST_AUTH: auth,
          CLAUDE_CODE_DISABLE_AGENT_VIEW: '0',
          API_TIMEOUT_MS: auth === 'api' ? '1000' : undefined,
          ...(auth === 'api' ? { ANTHROPIC_API_KEY: 'fake-test-key' } : {}),
        },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.args.at(-2), '--plugin-dir');
    assert.equal(result.args.at(-1), path.resolve(path.dirname(launcher), '..'));
    assert.equal(result.settingsCount, 1);
    assert.equal(result.settings.disableAgentView, true);
    assert.equal(result.agentView, '1');
    assert.equal(result.backgroundTasks, undefined);
    assert.equal(result.functionHooks, '1');
    assert.equal(result.apiTimeout, auth === 'api' ? '1000' : '2147483647');
    assert.deepEqual(result.settings.permissions.deny, ['Bash(denied)']);
    // Claude executes every tool here, so its own review keeps auto mode available
    // whenever Anthropic access exists.
    assert.equal(
      result.settings.permissions.disableAutoMode,
      auth === 'no' ? 'disable' : undefined,
    );
    assert.equal(
      result.hasLocalToken,
      true,
      'local hooks authenticate independently of Claude login',
    );
    assert.equal(result.auth, { no: 'local', api: 'api', yes: 'native' }[auth]);
    assert.equal(result.settings.hooks.PreToolUse?.length, 1);
  }
  const baseEnvironment = {
    PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
    HOME: cwd,
    ...windowsHome(cwd),
    CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
    CODEX_HOME: cwd,
  };
  const enabled = JSON.parse(
    (
      await promisify(execFile)(process.execPath, [launcher], {
        cwd,
        timeout: 20000,
        env: { ...baseEnvironment, TEST_PLUGIN: 'enabled' },
      })
    ).stdout,
  );
  assert(!enabled.args.includes('--plugin-dir'));
  const supplied = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        [launcher, '--', '--plugin-dir', path.resolve(path.dirname(launcher), '..')],
        { cwd, timeout: 20000, env: baseEnvironment },
      )
    ).stdout,
  );
  assert.equal(supplied.args.filter((arg: string) => arg === '--plugin-dir').length, 1);
  for (const auth of ['malformed', 'error', 'missing']) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [launcher, '--', '--model', 'multi/cursor/auto'], {
        cwd,
        timeout: 20000,
        env: {
          PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
          HOME: cwd,
          ...windowsHome(cwd),
          CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
          CODEX_HOME: cwd,
          TEST_AUTH: auth,
        },
      }),
      /Claude auth status probe (returned invalid JSON|failed|returned no boolean loggedIn field)/,
    );
  }
  await assert.rejects(
    promisify(execFile)(process.execPath, [launcher], {
      cwd,
      timeout: 20000,
      env: {
        PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
        HOME: cwd,
        ...windowsHome(cwd),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        TEST_CLAUDE_VERSION: '2.1.271',
      },
    }),
    /Claude Code 2\.1\.272 or newer with function hooks is required/,
  );
  await mkdir(path.join(cwd, 'claude'));
  await writeFile(
    path.join(cwd, 'claude', 'settings.json'),
    JSON.stringify({ model: 'multi/cursor/auto' }),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
      HOME: cwd,
      ...windowsHome(cwd),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
    },
  });
  const saved = JSON.parse(stdout);
  assert.deepEqual(
    saved.models,
    [],
    'Keep the native saved model instead of forcing a launcher default',
  );
  assert.equal(saved.settings.permissions.disableAutoMode, 'disable');
});

test('OpenRouter credentials add picker models and named workers without leaking the key to Claude', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-openrouter-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  await mkdir(bin);
  await writeClaudeFixture(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log('[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.OPENROUTER_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/openrouter/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-openrouter-gateway-token':process.env.OPENROUTER_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:false}));process.exitCode=1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
const agents=JSON.parse(args[args.indexOf('--agents')+1]);
result(JSON.stringify({settings,agents:Object.keys(agents),models:args.filter(x=>x.startsWith('openrouter/')),zenKeyInChild:process.env.OPENROUTER_API_KEY,args}));}
`,
  );
  const launcher = fileURLToPath(new URL('../../src/launcher.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [launcher, '--', '--model', 'openrouter/x/plain-tools', '--dangerously-skip-permissions'],
    {
      cwd,
      timeout: 20000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: cwd,
        ...windowsHome(cwd),
        XDG_DATA_HOME: path.join(cwd, 'data'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        OPENROUTER_API_KEY: 'openrouter-fixture-key',
        OPENROUTER_CATALOG_FILE: catalogFixture,
      },
    },
  );
  const result = JSON.parse(stdout);
  const pickerModels = result.settings.modelPicker.options.map(
    (option: { model: string }) => option.model,
  );
  // Only recommended ids present in the catalog become rows.
  assert.deepEqual(pickerModels, [
    'openrouter/anthropic/claude-sonnet-5',
    'openrouter/z-ai/glm-5.3',
  ]);
  assert.equal(
    result.settings.modelPicker.options.find(
      (row: { model: string }) => row.model === 'openrouter/z-ai/glm-5.3',
    ).behavesAs,
    'claude-sonnet-4-6',
  );
  assert(!pickerModels.includes('openrouter/x/plain-tools'));
  assert(result.agents.includes('openrouter-anthropic-claude-sonnet-5'));
  assert(result.agents.includes('openrouter-anthropic-claude-sonnet-5-high'));
  assert(!result.agents.includes('openrouter-x-plain-tools'));
  assert.equal(result.zenKeyInChild, undefined);
  assert.equal(result.settings.permissions.disableAutoMode, 'disable');
  assert(result.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(result.models, ['openrouter/x/plain-tools']);
  const disabled = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: cwd,
      ...windowsHome(cwd),
      XDG_DATA_HOME: path.join(cwd, 'data'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
      OPENROUTER_API_KEY: 'invalid key must not be read',
      OPENROUTER_ENABLED_PROVIDERS: '',
    },
  });
  const withoutProviders = JSON.parse(disabled.stdout);
  assert.deepEqual(withoutProviders.settings.modelPicker.options, []);
  assert.deepEqual(withoutProviders.agents, []);

  const launchFiltered = (selection: string, args: string[] = []) =>
    promisify(execFile)(process.execPath, [launcher, ...args], {
      cwd,
      timeout: 20000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: cwd,
        ...windowsHome(cwd),
        XDG_DATA_HOME: path.join(cwd, 'data'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
        CODEX_HOME: cwd,
        OPENROUTER_API_KEY: 'openrouter-fixture-key',
        OPENROUTER_CATALOG_FILE: catalogFixture,
        OPENROUTER_MODELS: selection,
      },
    });
  const filtered = JSON.parse(
    (await launchFiltered(' x/plain-tools, z-ai/glm-5.3,x/plain-tools ')).stdout,
  );
  assert.deepEqual(
    filtered.settings.modelPicker.options.map((option: { model: string }) => option.model),
    ['openrouter/x/plain-tools', 'openrouter/z-ai/glm-5.3'],
  );
  assert(filtered.agents.includes('openrouter-x-plain-tools'));
  const hidden = JSON.parse((await launchFiltered('')).stdout);
  assert.deepEqual(hidden.settings.modelPicker.options, []);
  await assert.rejects(launchFiltered('typo'), /OPENROUTER_MODELS/);
});

test('OpenRouter saved auth supplies the no-login fallback without exposing credentials', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-openrouter-saved-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  const config = path.join(cwd, 'config', 'claude-code-openrouter');
  await mkdir(bin);
  await mkdir(config, { recursive: true });
  await writeFile(
    path.join(config, 'auth.json'),
    JSON.stringify({ openrouter: { type: 'api', key: 'saved-openrouter-fixture-key' } }),
  );
  await writeClaudeFixture(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log('[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.OPENROUTER_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/openrouter/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-openrouter-gateway-token':process.env.OPENROUTER_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:false}));process.exitCode=1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
result(JSON.stringify({settings,models:args.filter(x=>x.startsWith('openrouter/')),zenKeyInChild:process.env.OPENROUTER_API_KEY}));}
`,
  );
  const launcher = fileURLToPath(new URL('../../src/launcher.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [launcher], {
    cwd,
    timeout: 20000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: cwd,
      ...windowsHome(cwd),
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      OPENROUTER_CATALOG_FILE: catalogFixture,
      OPENROUTER_MODELS: 'x/plain-tools,z-ai/glm-5.3',
    },
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.models, ['openrouter/x/plain-tools']);
  assert.equal(result.zenKeyInChild, undefined);
  assert.deepEqual(
    result.settings.modelPicker.options.map((option: { model: string }) => option.model),
    ['openrouter/x/plain-tools', 'openrouter/z-ai/glm-5.3'],
  );
});

test('launcher registers OpenRouter workers and keeps the representative catalog under 30 KB', () => {
  const rows = pickerOptions(parseCatalog(catalogPayload), undefined);
  const agents = workerDefinitions(rows);
  const definitions = JSON.stringify(agents);
  const definitionBytes = Buffer.byteLength(definitions);
  assert(Object.keys(agents).every((name) => name.startsWith('openrouter-')));
  assert(definitionBytes < 30000, `representative worker JSON was ${definitionBytes} bytes`);
  assert.equal(rows.length, 2);
});

test('launcher argument limits are platform-aware and identify largest providers', () => {
  const agents = {
    'openai-worker': {
      model: 'multi/openai/model',
      description: 'OpenAI',
      prompt: 'Complete the delegated task.',
      tools: ['Read'],
    },
    'cursor-worker': {
      model: 'multi/cursor/model',
      description: 'Cursor',
      prompt: 'Complete the delegated task.',
      tools: ['Read'],
    },
  };
  const invocation = {
    command: 'claude',
    args: ['--settings', 'settings.json', '--agents', 'x'.repeat(32000)],
  };
  assert.throws(
    () => checkLauncherArgumentLimit(agents, invocation, 'claude.exe', 'win32'),
    /above the Windows limit of 32,000.*openai.*Disable providers or extra models/,
  );
  assert.doesNotThrow(() =>
    checkLauncherArgumentLimit(
      agents,
      { command: 'cmd.exe', args: ['/c', 'claude.cmd', 'x'.repeat(7900)] },
      'C:\\bin\\claude.cmd',
      'win32',
    ),
  );
  assert.throws(
    () =>
      checkLauncherArgumentLimit(
        agents,
        { command: 'cmd.exe', args: ['/c', 'claude.cmd', 'x'.repeat(8000)] },
        'C:\\bin\\claude.cmd',
        'win32',
      ),
    /Windows cmd.exe shim limit of 8,000/,
  );
});

test('the OpenRouter model listing is available without authentication', async () => {
  const launcher = fileURLToPath(new URL('../../src/launcher.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [launcher, '--openrouter-models'],
    {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: os.tmpdir(),
        XDG_DATA_HOME: path.join(os.tmpdir(), 'missing-openrouter-data'),
        OPENROUTER_CATALOG_FILE: catalogFixture,
      },
    },
  );
  const models = JSON.parse(stdout);
  assert(models.some((model: { id: string }) => model.id === 'anthropic/claude-sonnet-5'));
  assert(!models.some((model: { id: string }) => model.id === 'meta/no-tools-model'));
});
