import type { ChildProcess } from 'node:child_process';
import { invalid } from '../app/errors.js';

export function relayFetch(origin: string, start: (signal: AbortSignal) => ChildProcess): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) invalid('MCP may contact only the approved isolated endpoint');
    const payload = JSON.stringify({
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: request.body ? await request.text() : undefined,
    });
    const child = start(request.signal);
    child.stdin!.on('error', () => undefined);
    child.on('error', (error) => child.stdout!.destroy(error));
    const response = child.stdout!.iterator();
    let buffered = Buffer.alloc(0);
    try {
      child.stdin!.end(payload);
      while (!buffered.includes(10)) {
        const part = await response.next();
        if (part.done || buffered.length > 64 * 1024)
          throw new Error('The isolated MCP HTTP relay did not return headers');
        buffered = Buffer.concat([buffered, part.value]);
      }
      const end = buffered.indexOf(10);
      const { status, headers } = JSON.parse(buffered.subarray(0, end).toString()) as {
        status: number;
        headers: [string, string][];
      };
      if (end > 64 * 1024) invalid('The isolated HTTP relay returned excessive headers');
      if ([204, 205, 304].includes(status)) {
        await response.return?.();
        return new Response(null, { status, headers });
      }
      buffered = buffered.subarray(end + 1);
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              if (buffered.length) {
                controller.enqueue(buffered);
                buffered = Buffer.alloc(0);
                return;
              }
              const part = await response.next();
              if (part.done) controller.close();
              else controller.enqueue(part.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel() {
            child.kill();
          },
        }),
        { status, headers },
      );
    } catch (error) {
      child.kill();
      throw error;
    }
  };
}
