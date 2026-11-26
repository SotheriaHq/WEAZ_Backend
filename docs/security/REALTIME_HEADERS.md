# HTTP and realtime security headers

Express responses and successful Engine.IO polling/upgrade responses use the shared policy in src/common/middleware/security-headers.ts. Engine.IO middleware also sets headers before polling protocol/session validation; rejected polling requests do not emit its normal headers event.

Engine.IO writes rejected WebSocket upgrades directly to the TCP socket. Those errors bypass application response headers. The HTTPS reverse proxy must therefore apply infrastructure/caddy/realtime-security.caddy inside the API site. Import the snippet definition, then add `import wiez_realtime_security` inside the existing site block. Preserve the existing hostname, TLS and reverse_proxy settings. The deferred response headers cover success and error statuses and mark transport responses no-store.

Before applying: back up the current Caddyfile; validate a complete candidate with caddy validate; replace atomically and reload only after validation. Recheck polling, invalid sid, unsupported protocol/transport and rejected WebSocket upgrades over HTTPS. Restore the saved file and reload if validation or reload fails. Never replace unrelated virtual hosts or credentials.

Run npm test -- src/common/middleware/security-headers.spec.ts --runInBand. This exercises the real Engine.IO gateway, checks protocol/session error responses and pins application/proxy policy parity. CI runs it before deployment.
