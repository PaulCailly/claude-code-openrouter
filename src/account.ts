import { authFile, readOpenRouterKey, saveOpenRouterKey } from './openrouter/auth.ts';
import { catalogFile, loadCatalog } from './openrouter/catalog.ts';
import { formatCredits, readCredits } from './openrouter/usage.ts';

async function secretInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Run claude-openrouter connect in your own terminal for hidden key entry. Do not paste the key into Claude.',
    );
  }
  process.stderr.write('OpenRouter API key (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const data = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        switch (character) {
          case '\u0003':
            finish(new Error('Key entry cancelled'));
            return;
          case '\r':
          case '\n':
            finish();
            return;
          case '\u007f':
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            if (/^[ -~]$/.test(character)) {
              value += character;
            }
        }
      }
    };
    process.stdin.on('data', data);
  });
}

async function connectOpenRouter() {
  if (await readOpenRouterKey()) {
    console.log('OpenRouter credentials found. Relaunch Claude to load OpenRouter models.');
    return 0;
  }
  console.log('Create an OpenRouter API key at https://openrouter.ai/keys');
  await saveOpenRouterKey(await secretInput());
  console.log(
    `OpenRouter key saved to ${authFile()}. Relaunch claude-openrouter to load the models.`,
  );
  return 0;
}

async function status() {
  const key = await readOpenRouterKey().catch(() => undefined);
  const credits = key ? formatCredits(await readCredits({ apiKey: key })) : undefined;
  let catalog: { count: number; source: string; fetchedAt: string } | { error: string };
  try {
    const loaded = await loadCatalog();
    catalog = { count: loaded.models.length, source: loaded.source, fetchedAt: loaded.fetchedAt };
  } catch (error) {
    catalog = { error: error instanceof Error ? error.message : String(error) };
  }
  console.log(
    JSON.stringify(
      {
        plugin: process.env.OPENROUTER_PLUGIN_ROOT ?? null,
        key: key ? 'stored' : 'missing',
        authFile: authFile(),
        catalogFile: catalogFile(),
        catalog,
        credits: credits ? { status: credits.status, summary: credits.summary } : null,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function models() {
  console.log(JSON.stringify((await loadCatalog()).models, null, 2));
  return 0;
}

function uninstall() {
  console.log(
    [
      'Remove the plugin:  /plugin uninstall openrouter@claude-code-openrouter',
      'Remove the command: npm rm -g claude-code-openrouter',
      `Remove the key:     rm ${authFile()}`,
      `Remove the cache:   rm ${catalogFile()}`,
      'Plain claude was never modified.',
    ].join('\n'),
  );
  return 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (args.length) {
    throw new Error('Usage: claude-openrouter connect | status | models | uninstall');
  }
  if (command === 'connect') {
    return connectOpenRouter();
  }
  if (command === 'status') {
    return status();
  }
  if (command === 'models') {
    return models();
  }
  if (command === 'uninstall') {
    return uninstall();
  }
  throw new Error('Usage: claude-openrouter connect | status | models | uninstall');
}

// The key is prompted for privately and never printed.
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
