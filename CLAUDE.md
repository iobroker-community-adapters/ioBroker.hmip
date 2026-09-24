# CLAUDE.md

ioBroker adapter for the **Homematic IP Cloud Access Point**. It talks to the HmIP cloud over its
REST API and a websocket, and mirrors the home — devices, groups, clients, rules — into ioBroker
objects and states.

## Commands

```bash
npm run build          # build-backend + build-admin
npm run build-backend  # tsc -p tsconfig.build.json   -> build/
npm run build-admin    # tsx tasks.ts                 -> admin/custom/
npm run check          # tsc -p tsconfig.json --noEmit
npm run lint           # eslint -c eslint.config.mjs .
npm run test:js        # the unit tests, against build/
npm run test:package   # @iobroker/testing package checks
npm run test:gui       # puppeteer against the admin dialog (legacy-testing)
```

`npm run test:js` needs `npm run build-backend` first: the unit tests load `build/main.js`.

The admin build has single steps for debugging: `task0clean`, `task1npm`, `task2compile`,
`task3copy`.

## Layout

```
src/main.ts              the adapter class, ~4000 lines: objects, states, the command dispatcher
src/lib/hmCloudAPI.ts    the cloud client: REST calls, websocket, the cached home
src/lib/channelStates.ts the table that says which states a functional channel type has
src/lib/types.ts         the shapes neither of them owns: the table's spec, the cloud payloads
src/lib/adapter-config.d.ts  the type of this.config - keep in sync with io-package.json native
build/                   the compiled output, gitignored, shipped through package.json files
admin/jsonConfig.json    the config dialog
src-admin/               the React component the dialog embeds, built by tasks.ts
tools/                   two manual api smoke tests, run by hand against build/
```

`build/` is not in the repository, so `io-package.json` carries `common.nogit: true`. There is
deliberately **no `prepare` script**: the build belongs in `npm run build` and in the CI
(`build: true` on the ioBroker actions), nowhere else.

## How a value gets written

1. A state object carries `native.parameter`. `_stateChange` returns immediately if it does not —
   a writable datapoint without one is settable and does nothing, which is why
   `testAdapterObjects` asserts every writable object declares one.
2. `_doStateChange` switches on that parameter and calls the matching `hmCloudAPI` method.
3. A device command addresses `native.id` + `native.channel`. The states that act on the channel's
   groups carry a list of group ids in `native.id` instead and go through `_targetGroups`.
4. `_doStateChange` has a `default` branch that warns; without it an unhandled parameter used to
   swallow the write without a trace.

`state.val` arrives as `ioBroker.StateValue` and is cast to what the datapoint's own object
declares. Those casts are the adapter's long-standing assumption written down, not new behaviour.

## Where states come from

`CHANNEL_STATES` in `channelStates.ts` maps a `functionalChannelType` to its states: 110 types,
817 states. `channelStateObjects` builds the ioBroker objects, `channelStateValues` reads the
values off a channel. `extends` pulls in a base channel's states. Groups, homes, rules and clients
are hand-written object trees in `main.ts` instead.

## Conventions

- Everything user-visible and every comment is in English. The one exception is the default
  profile names, which follow the ioBroker system language (`DEFAULT_PROFILE_NAMES`).
- Object ids, state roles, `native` field names and defaults are load-bearing: changing one
  breaks existing installations.
- Timers on the adapter are plain `setTimeout`/`setInterval` held in fields and cleared in
  `_unload`; this predates adapter-core's managed timers.
- `uuid` is gone — the package is ESM-only and could not be required from this CommonJS build.
  `randomUUID` from `node:crypto` takes its place.

## Release

`.releaseconfig.json` runs the iobroker, license and manual-review plugins. Put entries under
`### **WORK IN PROGRESS**` in README.md, with an `(@author)` prefix — **not** inside the HTML
comment above it, where neither a reader nor the release script would find them. Then
`npm run release-patch` (or `-minor` / `-major`).
