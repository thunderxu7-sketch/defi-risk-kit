# defi-risk-kit

Protocol-agnostic TypeScript SDK for DeFi lending risk — exact health factors with off-chain
interest accrual, oracle sanity checks, transaction simulation with decoded reverts, and
deleverage bundle building. Built on [viem](https://viem.sh).

> **Status: v0 — under active development.** Public API is unstable until `0.1.0`.
> Roadmap below reflects what is implemented vs. planned.

## Why

On-chain view functions return health factors that are stale between interest accruals, revert
reasons surface as opaque hex, and every lending protocol speaks its own dialect. This kit
normalizes lending markets behind one adapter interface and gives you four primitives:

| Module                   | What it does                                                                                                            | Status                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `defi-risk-kit/core`     | Domain types + strict bigint fixed-point math (WAD/RAY, documented rounding)                                            | ✅ types + math                                                                 |
| `defi-risk-kit/adapters` | `LendingAdapter` interface; **morpho-blue** adapter: reads, off-chain accrual, call encoding (configurable deployments) | ✅ fork-verified (Base)                                                         |
| `defi-risk-kit/health`   | Exact HF at any timestamp via off-chain accrual; liquidation price, buffers, max borrow/withdraw                        | ✅ fork-verified                                                                |
| `defi-risk-kit/oracle`   | Price normalization, drift vs. reference source, staleness checks                                                       | ✅                                                                              |
| `defi-risk-kit/simulate` | Batched `eth_call` simulation, human-readable revert decoding, allowance/balance preflight                              | ✅                                                                              |
| `defi-risk-kit/bundle`   | Ordered `Call[]` composition; deleverage builder; pluggable executors (multicall3 / protocol bundler / custom)          | ✅ fork-verified (protocol-bundler encodings deferred; custom seam covers them) |
| `defi-risk-kit/watch`    | Thin polling primitives emitting `HealthReport`s (no notifications, no decisions)                                       | ✅                                                                              |

The kit **reads, computes, simulates, and encodes calldata. It never signs, never broadcasts,
and never makes decisions** — that stays in your application.

## Install

Not yet published. Once `0.1.0` lands:

```bash
pnpm add defi-risk-kit viem
```

## Planned usage (target API)

```ts
import { createRiskKit } from 'defi-risk-kit'
import { morphoBlue } from 'defi-risk-kit/adapters'

const kit = createRiskKit({ client, adapters: [morphoBlue({ deployments })] })

const position = await kit.position(user, marketRef)
const health = kit.health(position, { at: Math.floor(Date.now() / 1000) }) // exact, accrued
const oracle = await kit.oracle.check(marketRef)

const bundle = kit.bundle.deleverage(position, { closeBps: 5000, slippageBps: 50, quoter })
const sim = await kit.simulate(bundle, { account: user }) // decoded revert on failure
```

## Design principles

- **bigint everywhere** — floating point never touches on-chain quantities.
- **Documented rounding** — debt rounds up, collateral capacity rounds down, mirroring
  mainstream lending implementations; every helper exposes explicit Down/Up variants.
- **Adapters are dumb** — read/compute/encode only; paradigm differences (isolated vs. pooled)
  normalize into one `HealthReport`.
- **Verified against chain state** — golden-vector unit tests plus anvil fork tests
  cross-check off-chain math against on-chain views.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Fork-based integration tests (require an RPC URL + [foundry](https://getfoundry.sh) anvil):

```bash
FORK_TESTS=1 FORK_RPC_URL=<url> pnpm test
```

## License

MIT © thunderxu7
