# Feature-flag vendor adapters (FR-403)

`@stagecraft/flags` lets a product keep its **real** flag SDK while prototyping. Flags are switched per session (per prototype, per viewer) in the Stagecraft panel or with the `flags_set` MCP tool, and the SDK reads those values. No request reaches the vendor.

| Adapter | How it works | Live panel changes | Tested with |
|---|---|---|---|
| In-house (`useFlag`) | Already in `@stagecraft/react` | yes | `journeys.test.ts` |
| OpenFeature (web) | `StagecraftProvider` wraps your real provider | yes, `ConfigurationChanged` | `@openfeature/web-sdk` 1.10.0 + `@openfeature/react-sdk` 1.4.1 |
| OpenFeature (server) | `StagecraftServerProvider` reads the request's session from the proxy | every evaluation is fresh | `@openfeature/server-sdk` 1.23.0 |
| LaunchDarkly | `ldMocks()` answers the SDK's own endpoints | yes, with `syncLaunchDarkly(client)` | `launchdarkly-js-client-sdk` 3.9.6, `@launchdarkly/js-client-sdk` 4.14.2 |
| GrowthBook (v1) | `growthbookMocks()` | yes, with `syncGrowthBook(gb)` | `@growthbook/growthbook` 1.8.0 |
| Unleash (v1) | `unleashMocks({ url })` | yes, with `syncUnleash(client)` | `unleash-proxy-client` 3.8.2 |
| Statsig, Split/Harness | not built | | |

Reference app: [`examples/ref-flags`](../examples/ref-flags) uses all five SDKs on one page. `tests/e2e/flags.test.ts` toggles each flag in the panel and checks that the UI changes, that no request left the machine (Playwright blocks every non-local host and the list of blocked requests must be empty), and that the proxy has no unmocked requests.

## Where values come from

Every adapter reads the session's **effective flags**: the `default` in `stagecraft.config.ts` → flags forced by the selected product states → the session's overrides (panel, MCP, share link, scenario). Declare every flag the prototype needs in `flags` in `stagecraft.config.ts`, with the same key the SDK uses. A flag that Stagecraft does not know resolves to the default value passed in code.

Values are per session, so two viewers (or two compare frames) see different values at the same time.

## OpenFeature (web)

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { StagecraftProvider } from '@stagecraft/flags/openfeature';

OpenFeature.setProvider(new StagecraftProvider({ fallback: realProvider }));
```

- Under Stagecraft (the proxy injected `window.__STAGECRAFT__`): booleans, strings, numbers and objects resolve from `window.__STAGECRAFT__.flag(key, default)`. Reason `STATIC` when Stagecraft defines the flag; `DEFAULT` (the code default) when it does not; `ERROR`/`TYPE_MISMATCH` when the value has another type. `flagMetadata.source` is `"stagecraft"`.
- When the panel, MCP, a persona or a state changes a flag, the provider emits `ConfigurationChanged` with `flagsChanged`, so `@openfeature/react-sdk` hooks re-render. No reload.
- `fallback` is **never initialized** under Stagecraft, so it makes no network call.
- In production (no runtime) the provider delegates everything to `fallback`: its `initialize`, `events`, `hooks`, `onContextChange`, `track` and resolvers. With no fallback it returns the default values.

Create the provider in browser code that runs after the page loads (the runtime is a classic script in `<head>`, so module scripts see it).

## OpenFeature (server: SSR, RSC, API routes)

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { StagecraftServerProvider } from '@stagecraft/flags/openfeature-server';

await OpenFeature.setProviderAndWait(new StagecraftServerProvider({ fallback: realServerProvider }));
```

- Active when `STAGECRAFT_PROXY` is set, which `stagecraft dev` does for the dev server. Each evaluation calls `GET /__stagecraft/api/session` on the proxy. The Stagecraft preload (`node --import @stagecraft/server/preload`, also set by `stagecraft dev`) adds the session of the incoming page request to that call, so server code sees the same flags as the browser of that viewer.
- Outside a request (a script, a worker), pass the session in the evaluation context: `{ stagecraftSession: 'f1abc' }`.
- If the proxy cannot be reached, the evaluation returns the default with reason `ERROR`. It never falls back to the real vendor during prototyping.
- One HTTP round trip to the local proxy per evaluation. Fine for prototypes; there is no cache.
- Edge runtimes are not covered (no preload there), same as the rest of SSR support.

## LaunchDarkly (client-side SDKs)

`stagecraft.config.ts`:

```ts
import { ldMocks } from '@stagecraft/flags/mocks';

const flags = { 'new-checkout': { default: false }, banner: { default: 'none', options: ['none', 'sale'] } };
const ld = ldMocks({ defs: flags });   // options: flags (keys to expose), extra (fixed values), hosts (relay proxy)

export default defineConfig({
  apiOrigins: ['/api', ...ld.apiOrigins],
  handlers: { ...handlers, ...ld.handlers },
  flags,
  // ...
});
```

Product code keeps its client-side ID, context and default hosts. Add one line so panel changes show without a reload:

```ts
import { syncLaunchDarkly } from '@stagecraft/flags';
const client = initialize(clientSideId, context);   // or createClient(...) + client.start() in v4
syncLaunchDarkly(client);                          // no-op in production
```

The runtime sends the SDK's XHR, fetch and EventSource requests for the LaunchDarkly hosts to the proxy, and the handlers answer from the session's flags with LaunchDarkly's client-side shape `{ value, variation, version, flagVersion, trackEvents: false }` (plus `reason: { kind: 'FALLTHROUGH' }` when the SDK asks `withReasons=true`). `variation` is the index in the flag's `options` (booleans: `true` = 0, `false` = 1).

**Why `syncLaunchDarkly`.** LaunchDarkly pushes flag changes over a server-sent-events stream. Stagecraft mock handlers return one response each and cannot hold a stream open, so the stream endpoints answer `204` and the SDK keeps working from polling. `syncLaunchDarkly` listens for Stagecraft flag changes and calls `client.identify(client.getContext())`, which makes the SDK poll again and fire its normal `change` events. `syncLaunchDarkly(client, { mode: 'reload' })` reloads the page instead. Caveat: with secure mode, `identify` without the hash drops the hash; pass your own refetch through `onStagecraftFlags` in that case.

### Endpoints, verified from the installed SDK sources

| Request | v3 `launchdarkly-js-client-sdk` 3.9.6 | v4 `@launchdarkly/js-client-sdk` 4.14.2 | Mock answer |
|---|---|---|---|
| Polling `GET /sdk/evalx/{env}/contexts/{base64url(context)}` | `app.launchdarkly.com` | `clientsdk.launchdarkly.com` | 200, flags |
| Polling, `useReport`: `REPORT /sdk/evalx/{env}/context` | same | same | 200, flags |
| Streaming `GET /eval/{env}/{base64url(context)}` | `clientstream.launchdarkly.com` | same | 204 |
| Streaming, `useReport`: `REPORT /eval/{env}` or `GET /ping/{env}` | same | same | 204 |
| Goals `GET /sdk/goals/{env}` | `app.launchdarkly.com` | `clientsdk.launchdarkly.com` | `[]` |
| Events `POST /events/bulk/{env}` | `events.launchdarkly.com` | same | 202 |
| Diagnostics `POST /events/diagnostic/{env}` | same | same | 202 |

Sources read (paths under `node_modules/`):
- v3 polling: `launchdarkly-js-sdk-common/src/Requestor.js` (`fetchFlagSettings`; requires `content-type: application/json`, 404 means "invalid environment"). Default hosts: `launchdarkly-js-sdk-common/src/configuration.js`. Stream URLs and retry backoff (1 s doubling, max 30 s): `launchdarkly-js-sdk-common/src/Stream.js`. Stream opens only with `streaming: true` or a `change` listener: `updateStreamingState()` in `launchdarkly-js-sdk-common/src/index.js`. Events: `EventProcessor.js` (`/events/bulk/`) and `diagnosticEvents.js` (`/events/diagnostic/`). Browser transport (XHR, `window.EventSource`) and goals: `launchdarkly-js-client-sdk/dist/ldclient.es.js`.
- v4: `@launchdarkly/js-client-sdk-common/dist/esm/index.mjs` (`browserFdv1Endpoints`, `DEFAULT_POLLING`, `DEFAULT_STREAM`), `@launchdarkly/js-sdk-common/dist/esm/index.mjs` (`DEFAULT_EVENTS`), `@launchdarkly/js-client-sdk/dist/index.js` (`/events/bulk/`, `/events/diagnostic/`, `/sdk/goals/`, `fetch` and global `EventSource`).
- The E2E test records the requests the two SDKs actually make in Chromium and checks them against this table.

### LaunchDarkly limits

- **FDv2 data system** (v4 with the `dataSystem` option: `/sdk/poll/eval`, `/sdk/stream/eval`) is not mocked; its payload format is different. The default FDv1 path is.
- **Mobile/React Native** (`/msdk/evalx`, `/meval`) and **server-side** LaunchDarkly SDKs are not mocked (their sources were not read). For server code use OpenFeature with `StagecraftServerProvider`, or the client-side SDK.
- `bootstrap: 'localstorage'` serves the previous page's flags first, then the polled ones (SDK behaviour).
- Requests from Web Workers are not routed (Stagecraft limit, see the README).
- The stream mock answers 204, so the SDK logs a stream warning and retries with backoff (the E2E test checks that both SDKs together make fewer than 12 stream requests while it runs).
- The old v2 `/users/` paths are not in the installed SDKs and are not mocked.

## GrowthBook (client-side evaluation)

```ts
// stagecraft.config.ts
const gb = growthbookMocks();                         // { apiHost } for a self-hosted or proxy host
// product code
const growthbook = new GrowthBook({ apiHost, clientKey, disableCache: isStagecraft() });
await growthbook.init();
syncGrowthBook(growthbook);
```

- Mocked: `GET {apiHost}/api/features/{clientKey}` → `{ features: { key: { defaultValue } } }` (no rules, so every feature evaluates to its value). Source: `@growthbook/growthbook/dist/esm/feature-repository.mjs` (`fetchFeaturesCall`, default host in `core.mjs`, `feature.defaultValue` in `core.mjs`).
- The response has no `x-sse-support` header, so the SDK never opens its `/sub/{clientKey}` stream (`startAutoRefresh` in `feature-repository.mjs`).
- Set `disableCache: isStagecraft()`: GrowthBook caches features per host + client key in `localStorage` for a minute, so a reload or another session would otherwise show stale values.
- Not mocked: remote evaluation (`POST /api/eval/{clientKey}`), encrypted features, experiments/tracking.

## Unleash (Frontend API / Edge, `unleash-proxy-client`)

```ts
// stagecraft.config.ts
const un = unleashMocks({ url: 'https://unleash.acme.com/api/frontend' });   // the url your client uses
// product code
const unleash = new UnleashClient({ url, clientKey, appName });
unleash.start();
syncUnleash(unleash);
```

- Mocked: `GET {url}` (context in the query string), `POST {url}` (`usePOSTrequests`), `POST {url}/client/metrics` → 200. Source: `unleash-proxy-client/build/main.esm.js` (`fetchToggles`, the metrics sender, `updateToggles`).
- A boolean flag is a toggle's `enabled`. Any other value is an enabled toggle whose variant is named after the value and carries it as payload (`string`, `number` or `json`), so `getVariant(key).payload.value` returns it.

## Statsig, Split/Harness

Not built. Their SDKs' initialize/download payloads were not verified against installed sources in this slice, and guessing a payload format is not good enough. For either, OpenFeature (both vendors ship OpenFeature providers) plus `StagecraftProvider` works today.

## Mock-DB events

The proxy notifies the app (`useMockDbVersion`, the panel) after every non-GET mock request, because it usually writes the mock DB. SDK telemetry (`POST /events/bulk`, metrics) and `REPORT` evaluations are not writes, so these handlers return `readOnly: true` on their reply, a new optional `MockReply` field. Use it in your own handlers for POST requests that do not write.

## Writing an adapter for another SDK

Every factory returns `{ apiOrigins, handlers }` built from `ctx.flags` (the session's effective flags), and every browser helper is `onStagecraftFlags(changed => sdk.refetch())`. Read the SDK source for its endpoints and payload, add a mapping function and a unit test, and add the SDK to `examples/ref-flags` and `tests/e2e/flags.test.ts`.
