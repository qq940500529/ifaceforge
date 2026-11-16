import type { CommandInput } from '../app/workbench.js';

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
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'text/plain' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
