// Which request headers reach a vibe's worker. Single source of truth for
// production dispatch (src/services/dispatch-headers.ts) and `vibe dev`
// (skills/vibe-coded-ai/runtime/dispatch-header-policy.mjs, a byte-identical
// copy checked by scripts/build/verify-skill-shim-sync.mjs). Default deny: a
// header is forwarded only if it is not blocked and is on an allowlist.
// The exported lists are frozen and the Sets the decision reads are
// module-private, so no importer can change the policy at runtime.

/** Headers explicitly allowed to forward to user workers. */
export const ALLOWED_HEADERS = Object.freeze([
    // Content negotiation
    'accept',
    'accept-language',
    'accept-encoding',

    // Request body
    'content-type',
    'content-length',

    // Range requests
    'range',

    // Conditional requests (caching)
    'if-none-match',
    'if-modified-since',

    // CORS/Security context
    'origin',
    'referer',

    // Client info
    'user-agent',

    // Fetch metadata (security)
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'sec-fetch-user',

    // Client hints
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
]);

/**
 * Webhook signature headers forwarded so a vibe can verify a webhook it
 * receives. Any client can send these names, so their
 * presence proves nothing about the sender: authenticity comes only from the
 * vibe validating the signature or token value. They are safe to forward
 * because browsers never attach them automatically, so none is an ambient
 * credential the way Cookie and Authorization are. Values pass through
 * unmodified: signature checks are byte-exact.
 */
export const WEBHOOK_SIGNATURE_HEADERS = Object.freeze([
    'stripe-signature',                                       // Stripe
    'x-hub-signature', 'x-hub-signature-256',                 // GitHub
    'x-signature',                                            // Lemon Squeezy and others
    'svix-id', 'svix-timestamp', 'svix-signature',            // Svix (Resend, Clerk)
    'webhook-id', 'webhook-timestamp', 'webhook-signature',   // Standard Webhooks
    'x-shopify-hmac-sha256',                                  // Shopify
    'x-twilio-signature',                                     // Twilio
    'x-slack-signature', 'x-slack-request-timestamp',         // Slack
    'linear-signature',                                       // Linear
    'x-gitlab-token',                                         // GitLab
]);

/**
 * App-defined webhook headers (e.g. `X-Webhook-Token` holding a shared secret
 * the vibe stores with `vibe secrets`). No platform header uses this prefix;
 * dispatch-headers.test.js (INV-B1-6) locks that.
 */
export const WEBHOOK_HEADER_PREFIX = 'x-webhook-';

/** Headers never forwarded under any circumstances. */
export const BLOCKED_HEADERS = Object.freeze([
    'cookie',
    'authorization',
    'proxy-authorization',
    'x-forwarded-for',
    'x-real-ip',
]);

/** Prefixes for headers that are always dropped. */
export const BLOCKED_PREFIXES = Object.freeze([
    'cf-access-',    // Cloudflare Access headers
    'x-internal-',   // Internal platform headers
    'x-vc-',         // Our context headers (we'll inject fresh ones)
    'cf-',           // Cloudflare internal headers (we selectively allow some via injection)
]);

const allowed = new Set(ALLOWED_HEADERS);
const webhookSignatures = new Set(WEBHOOK_SIGNATURE_HEADERS);
const blocked = new Set(BLOCKED_HEADERS);

/**
 * Whether a client-sent request header may be forwarded to a vibe's worker.
 * @param {string} name header name, any case
 * @returns {boolean}
 */
export function isForwardableHeader(name) {
    const lowerName = name.toLowerCase();
    if (blocked.has(lowerName)) return false;
    if (BLOCKED_PREFIXES.some((prefix) => lowerName.startsWith(prefix))) return false;
    return allowed.has(lowerName)
        || webhookSignatures.has(lowerName)
        || lowerName.startsWith(WEBHOOK_HEADER_PREFIX);
}
