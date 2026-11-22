# What counts as an API call

The same answer is on the pricing page.

Every request your vibe's backend handles, including tool calls from an AI, plus builds and storage use. A file write counts as about one call, a storage read or file view as a fraction of a call, and five SQL rows written as about one call. A normal vibe uses a few hundred calls a month. If your account goes past its monthly calls, your vibes pause until the 1st or an upgrade; nothing is deleted.

## Outbound connections

The worker reaches the outside world through web requests (`fetch`), outbound WebSockets and server-sent event streams. It cannot open raw TCP or TLS sockets, and it cannot serve inbound WebSocket connections; the platform answers those upgrades itself.
