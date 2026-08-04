# defi-risk-kit

Protocol-agnostic TypeScript SDK for DeFi lending risk — exact health factors with off-chain
interest accrual, oracle sanity checks, transaction simulation with decoded reverts, and
deleverage bundle building. Built on [viem](https://viem.sh).

> **Status: public preview.** The API is still evolving before the `0.1.0` stable release.
> The current implementation is usable for Morpho Blue integrations and risk-tooling
> experiments; follow the changelog before upgrading.

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

The public preview package is available as `0.0.2`. This is a complete quickstart from a
clean directory:

```bash
mkdir defi-risk-demo
cd defi-risk-demo
npm init -y
pnpm add defi-risk-kit viem
cat > quickstart.mjs <<'EOF'
import { createPublicClient, getAddress, http } from 'viem'
import { computeHealth, morphoBlue } from 'defi-risk-kit'

const rawUser = process.env.USER_ADDRESS
if (!rawUser) throw new Error('USER_ADDRESS is required, e.g. USER_ADDRESS=0x...')

const rpcUrl = process.env.RPC_URL ?? 'https://mainnet.base.org'
const client = createPublicClient({ transport: http(rpcUrl) })
const adapter = morphoBlue()
const market = {
  chainId: 8453,
  protocol: 'morpho-blue',
  marketId: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836',
}

const state = await adapter.getMarket(client, market)
const position = await adapter.getPosition(client, getAddress(rawUser), market)
const report = computeHealth(adapter, position, state, { at: Math.floor(Date.now() / 1000) })

console.log('user     ', position.user)
console.log('market   ', state.collateralToken, '→', state.loanToken)
console.log('HF       ', report.healthFactor)
console.log('debt     ', report.debtAssets)
console.log('liq price', report.liquidationPrice)
console.log('buffer   ', report.bufferBps, 'bps')
EOF
RPC_URL=https://base-rpc.publicnode.com USER_ADDRESS=0x... node quickstart.mjs
```

The quickstart reads the market and position on-chain, then computes an accrued health report
without signing or broadcasting a transaction. For the TypeScript source examples, clone the
repository and run:

```bash
git clone https://github.com/thunderxu7-sketch/defi-risk-kit.git
cd defi-risk-kit
pnpm install
RPC_URL=https://base-rpc.publicnode.com USER_ADDRESS=0x... pnpm exec tsx examples/read-health.ts
```

More complete source examples are available in [`examples/`](examples/): oracle checks and
deleverage calldata planning.

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
