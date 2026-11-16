import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const version = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export function openLocation(target: string) {
  const executable =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(executable, [target], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    /* The CLI also returns the path. */
  });
  child.unref();
}
