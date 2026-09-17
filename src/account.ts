import { fileURLToPath } from 'node:url';
import { providerSelection } from './install/plugins.ts';
import { run } from './install/process.ts';
import { readOpenRouterKey, saveOpenRouterKey } from './openrouter/auth.ts';

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
    'OpenRouter key saved to OpenRouter auth. Relaunch Claude to load OpenRouter models.',
  );
  return 0;
}

async function main() {
  const [command, provider, ...args] = process.argv.slice(2);
  const enabled = providerSelection(process.env.OPENROUTER_ENABLED_PROVIDERS) ?? [];
  if (!enabled.some((name) => name === provider)) {
    throw new Error('Install and enable the openrouter plugin first.');
  }
  if (command === 'connect' && provider === 'openrouter' && args.length === 0) {
    return connectOpenRouter();
  }
  throw new Error('Usage: claude-openrouter status | connect | uninstall');
}

// Browser links are emitted by the provider-owned login process. Never read tokens.
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
