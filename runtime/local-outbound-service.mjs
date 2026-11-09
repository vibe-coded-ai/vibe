import gateway from './outbound-worker.js';

export default {
  fetch(request, env) {
    const cf = { ...request.cf };
    const invocation = cf.localVibeInvocation;
    delete cf.localVibeInvocation;
    // The real gateway validates all six bindings and handles every redirect
    // hop. Missing invocation data reaches its closed parameter check.
    return gateway.fetch(new Request(request, { cf }), { ...env,
      invocationId: invocation?.invocationId, openedAt: invocation?.openedAt });
  },
};
