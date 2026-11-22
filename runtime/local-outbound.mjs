import { AsyncLocalStorage } from 'node:async_hooks';

const invocation = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;

// Local Miniflare has no dispatch-time outbound bindings. Carry the two fresh
// invocation values to its outbound service; the other four bindings are fixed
// by buildMfOptions. This local transport is a convenience, not an authority.
globalThis.fetch = (input, init) => {
  const scope = invocation.getStore();
  if (!scope) throw new Error('Outbound invocation unavailable');
  const request = input instanceof Request ? input : undefined;
  return nativeFetch(input, { ...init, cf: { ...(init?.cf ?? request?.cf),
    localVibeInvocation: scope } });
};

export function withLocalOutbound({ invocationId, openedAt }, task) {
  return invocation.run({ invocationId, openedAt }, task);
}
