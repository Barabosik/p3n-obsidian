# Contributing

Node 22.18 or later (the unit tests run TypeScript directly).

```bash
npm ci
npm run build   # type-check, then main.js
npm run lint    # eslint-plugin-obsidianmd: the rules the community directory's review uses
npm test        # unit tests: the API client, the result copy, selection and Replace
```

`npm run dev` rebuilds `main.js` on every change. To try it in a vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/ai-pen/` and reload Obsidian.

## In a real Obsidian

`scripts/e2e.mjs` runs the plugin in the Obsidian desktop app you have installed, over the DevTools protocol: commands, the right-click menu, the results, Replace selection and a real Ctrl+Z, errors, the key, the settings tab, dark theme, and Obsidian's phone layout. It starts Obsidian with its own profile and a throwaway vault under `.e2e/`, so your vaults and settings aren't touched. API calls are answered in the page with canned runs; nothing reaches api.p3n.si.

```bash
npm run build && node scripts/e2e.mjs
```

- `OBSIDIAN=path/to/Obsidian.exe` if Obsidian isn't in the usual Windows place.
- `ASAR=path/to/obsidian-x.y.z.asar` to run another Obsidian version; the default is the newest in your Obsidian profile.
- `SHOTS=1` saves screenshots to `.e2e/shots/`. `ONLY=check,rewrite` runs some scenarios. `KEEP=1` leaves Obsidian open.
- `LIVE=1` instead runs one Check and one Rewrite against the real API: 2 of the 10 free calls an hour.

## Releasing

1. `npm version 0.1.1` sets the version in `package.json`, `manifest.json` and `versions.json`, commits and tags `0.1.1` (no `v`: the community directory wants the tag to equal the version).
2. `git push && git push --tags`. The Release workflow builds, lints and tests, then publishes a GitHub release with `main.js`, `manifest.json` and `styles.css` and a build attestation.

Raise `minAppVersion` in `manifest.json` before a release that needs a newer Obsidian.
