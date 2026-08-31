# wangdachui.pi · Stateful Multi-Turn LLM Agent Runtime

A zero-dependency, stateful multi-turn LLM agent runtime in TypeScript (Node ≥ 22): deterministic context engineering, side-model structured memory, a tool-call loop with user decision cards, and multi-provider failover — with **no third-party runtime dependencies** (hand-written RFC 6455 WebSocket, SSE streaming, PNG chunk parsing, local n-gram TF-IDF retrieval).

The bundled role-play campaign is just a demo application; the core is a general agent architecture where **deterministic code owns memory and state, and the model only writes generation**.

## Measured Results (live eval, deepseek-v4-flash-0731)

| Metric | Result | Notes |
| --- | --- | --- |
| Memory retention after compression | **85.4%** (41/48) | 12 multi-turn scenarios × 4 facts, probed after forced compression under a 300-char budget (keyword-level, conservative) |
| Token savings from compression | **12.9%** (normal-output cases) | Long narratives compressed by side model, 8 scenarios avg |
| Key-fact retention in summaries | **97.1%** (34/35) | Same runs, normal-output cases |
| Multi-provider failover | verified live | Auto-switched after 3 consecutive primary failures; service uninterrupted |
| Probe latency (end-to-end) | ~13 s | flash-tier model; streaming reduces perceived latency |

Full methodology, per-scenario tables, and failure analysis: [`reports/EVALUATION.md`](reports/EVALUATION.md). Reproduce: `node scripts/eval/runner.ts --live` (default mock mode costs no tokens).

## Highlights

- **Context engineering** — model sees only `system → summary → sliding window`; over-budget turns are compressed into a summary by a side model and archived to `archive.jsonl` for keyword/semantic recall (compression with controllable loss, not deletion).
- **Side-model memory** — per-turn structured JSON deltas (characters/items/relations/plots/notes) merged by key into `ledger.json`; ledger failure degrades gracefully without blocking the narrative.
- **Agent loop safety** — loop cap, intermediate reasoning never leaks to output, tool errors fed back for self-correction, daily token guardrail.
- **Multi-provider failover** — network/5xx/401/403/404 trigger fallback to the next OpenAI-compatible gateway; 429 retries within provider first; 400/422 never switch.
- **Model tiering** — cheap models for scribe/compress side tasks (`WANGDACHUI_SCRIBE_MODEL` / `WANGDACHUI_COMPRESS_MODEL`).
- **Observability** — structured JSON-line logs + `GET /metrics` (Prometheus text: token usage, latency quantiles, provider switches, compression events).
- **Zero-dependency engineering** — RFC 6455 server, SSE client, PNG chunk parsing, and TF-IDF vector retrieval all hand-written; Node 22 runs TS natively.

Architecture decisions: [`docs/adr/`](docs/adr/README.md) (6 ADRs).

## Quick Start

```bash
cp .env.example .env   # set WANGDACHUI_API_KEY (ignored by git)
npm install            # devDependencies only (typescript etc.)
npm run web            # http://127.0.0.1:7620
```

```bash
npm test               # 57 unit tests (mock LLM, no tokens)
npx tsc --noEmit       # strict type check
node scripts/eval/runner.ts   # eval harness (mock default; --live for real model)
```

## License

MIT.
