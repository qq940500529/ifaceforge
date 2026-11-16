import type { CommandInput } from '../app/workbench.js';
import type { Result } from '../desktop/protocol.js';

let bootstrap: Promise<string> | undefined;
export class WebError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}
async function csrf() {
  const response = await fetch('/api/v1/bootstrap');
  if (!response.ok) throw new WebError('FORBIDDEN', 'Could not initialize the request session', null);
  return ((await response.json()) as { csrf: string }).csrf;
}
export async function command<T>(name: string, input: CommandInput = {}): Promise<T> {
  bootstrap ??= csrf().catch((error) => {
    bootstrap = undefined;
    throw error;
  });
  const response = await fetch('/api/v1/commands/' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ifg-csrf': await bootstrap },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 403) bootstrap = undefined;
    throw new WebError(result.code, result.message, result.details);
  }
  return result as T;
}
export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const value = await result;
  if (!value.ok) throw new WebError(value.error.code, value.error.message, value.error.details);
  return value.data;
}

export function scopedCommand(project: string): typeof command {
  return async <T>(name: string, input: CommandInput = {}): Promise<T> =>
    unwrap(window.ifaceforge!.command(project, name, input)) as Promise<T>;
}

export async function copyText(text: string) {
  if (window.ifaceforge) return unwrap(window.ifaceforge.copy(text));
  return navigator.clipboard.writeText(text);
}

export function download(name: string, data: unknown) {
  if (window.ifaceforge) {
    return unwrap(
      window.ifaceforge.download(name, typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
    );
  }
  const url = URL.createObjectURL(
    new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'text/plain' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
