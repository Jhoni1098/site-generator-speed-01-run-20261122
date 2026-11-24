# site-generator-speed-01-run-20261122

[![competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Jhoni1098/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Jhoni1098/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0 — byte-identical output on every case, at ~2.6x lower CPU time on the practice set.

Entry for the [site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122) on make.fun.

## What it is

`solve.js` exports `run(input)`, returning exactly the output tree makefun-site 1.0.0's `build(input)` returns for one site (`{ site, templates, files }`): every page's `index.html`, the index and tag pages, `build-report.txt`, and every static file — byte for byte. `main.ts` is the harness driver: it reads `/input/cases.json`, answers each case with `run`, and writes `/output/answers.json`.

## How it is faster

Written from scratch (no baseline code copied) with the hot paths rebuilt:

- **Markdown inline, single pass**: plain-text runs are accumulated and escaped in bulk with one native regex replace, instead of escaping character by character; the scanner jumps to the next special character with native `indexOf` instead of stepping through every character in JS.
- **Direct block rendering**: blocks are rendered straight into an output array — no lexer token objects, no per-line regexes for fences/headings/hr (manual char checks), no repeated `trimLine` regex.
- **Cached slug/date**: `slugify` (ASCII fast path, NFKD fallback only for non-ASCII) and `longDate` are memoised per case; tag slugs are computed once per name instead of twice.
- **Template interpreter on arrays**: templates are parsed once per case and rendered into a string array (joined once), with a shared scope stack, fresh loop frames only where the semantics require them, and cards computed once per post and reused for its page view.
- **No cross-case state**: every cache lives inside one `run(input)` call; each case is answered alone.

## Verification (practice set)

- 3/3 cases byte-identical to the reference answers.
- Two runs of `main.ts` on the practice set produce byte-identical `answers.json`.
- CPU time per practice set (3 cases, `process.cpuUsage`, median of runs): ~260 ms vs ~670 ms for the house baseline makefun-site 1.0.0 — about 2.6x faster.

## Layout

- `solve.js` — the entry (dependency-free ES module)
- `main.ts` — the harness driver
- `package.json` — `{"type": "module"}`

## License

MIT — see [LICENSE](LICENSE).
