# Santo Widget — Phase 10 implementation contract

> Initial status: UI shell only. This is not an authenticated or production-ready chat widget.

The Santo customer integration embeds a framework-independent Lit
`<santo-ai>` custom element. Lit's default Shadow DOM owns UI styling;
no global style resets and no customer DB connections are permitted.

## First implementation slice

- The current component renders a floating launcher, accessible panel,
  compact/full-screen toggle, library filter, disconnected status, and
  disabled composer.
- The application label can be set using `assistant-name`. Library
  options may be assigned from host JavaScript to the `libraries`
  property as `[{id, label}]`. Empty value means **All libraries**.
- The `santo-ui-change` event informs the host of display and filter
  changes without transmitting medical content or server credentials.
- This first slice deliberately **does not** accept a fake auth token,
  issue AI requests, persist questions, render model HTML or claim that
  disabled composer UI is working chat. No billing or network side effect
  is possible from this component yet.
- The UI reducer rejects invalid/unexpected filter IDs and preserves the
  current library selection through panel/fullscreen transitions.
- The shell respects narrow viewports, keyboard focus, accessible labels,
  and reduced-motion preferences.

## Required next slices before widget acceptance

1. Define a `sessionProvider` callback obtained from **customer backend**
   session exchange. It returns a short-lived *Santo end-user* Bearer token,
   not a tenant server credential. Widget must never read server secrets.
2. Build a typed, retry-safe API adapter using existing shared Santo
   contracts: create/read/ask/turns and authenticated sources/details/image
   proxy. Keep persistent conversation UUID, expectedSequence and
   idempotency keys on retries.
3. Render structured, verified responses and citations only. Sanitize or
   escape all model text, never interpret it as arbitrary HTML. Use
   validated buffered SSE completion before treating the answer as final.
4. Handle reconnects and 401/403/409/429/503, restore persisted turns and
   quota state without duplicate charge; implement cancellation.
5. Add real browser-level, mobile and authenticated staging acceptance.

## Security boundary

The Widget is a browser view/network client only. It must never import
Workers control-plane repositories, read Cloudflare R2 directly, authorize
tenants, calculate quota, fabricate citations, or access any customer's DB.

See Issue #58, Issue #52 and `docs/CONVERSATION_STATE_CONTRACT.md`.
