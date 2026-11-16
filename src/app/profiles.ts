import { type Profile, type Pair, secretHeader } from '../protocols/variables.js';

export function safeProfile(profile: Profile): Profile {
  // Retain environment reference names so an exported profile remains editable.
  const mask = (pairs?: Pair[]) =>
    pairs?.map((pair) =>
      secretHeader.test(pair.name) && typeof pair.value === 'string' && !pair.value.includes('{{')
        ? { ...pair, value: '[REDACTED]' }
        : pair,
    );
  const output = structuredClone(profile);
  if (output.http?.headers) output.http.headers = mask(output.http.headers);
  if (output.mcp?.transport === 'streamableHttp' && output.mcp.headers) {
    output.mcp.headers = mask(output.mcp.headers);
  }
  return output;
}
