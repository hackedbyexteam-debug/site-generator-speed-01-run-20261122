# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hackedbyexteam-debug/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hackedbyexteam-debug/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in for make.fun's own makefun-site 1.0.0 static site
generator. For every case's input it returns exactly the output tree makefun-site
1.0.0's build returns — each page's `index.html`, the index and tag pages,
`build-report.txt` and each static file, byte for byte — but in a fraction of the
CPU time.

How it is fast: a single-pass line scanner for the Markdown subset, batched HTML
escaping (plain runs are escaped in one go instead of a character at a time),
cached slugs, per-source link resolution caching, and templates compiled once per
case into plain string-building functions (includes inlined at compile time, loop
variables as real locals). No dependencies, no native code, no precomputed
answers — everything is computed from the input at run time.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`
outside a container) and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`):
a JSON array of the answers, one per case in the cases' order. `solve.js` is the
entrypoint: its `run(input)` returns makefun-site's answer for one case's input.
Node 22+ is all it needs.

---

<sub>Entered on [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
