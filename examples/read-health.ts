// pnpm dlx tsx examples/read-health.ts
// Reads a real Base Morpho market and computes an exact, accrued health report
// for a hypothetical position.
import { createPublicClient, http } from 'viem'

import { computeHealth, morphoBlue } from '../src/index'
import type { MarketRef } from '../src/index'

const client = createPublicClient({ transport: http('https://mainnet.base.org') })
const adapter = morphoBlue()
const ref: MarketRef = {
  chainId: 8453,
  protocol: 'morpho-blue',
  // cbBTC/USDC on Base
  marketId: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836',
}

const state = await adapter.getMarket(client, ref)
const report = computeHealth(
  adapter,
  {
    user: '0x0000000000000000000000000000000000000001',
    market: ref,
    collateral: 10n ** BigInt(state.collateralDecimals), // 1 collateral token
    borrowShares: state.totalBorrowShares / 1_000_000n,
    supplyShares: 0n,
  },
  state,
  { at: Math.floor(Date.now() / 1000) },
)

console.log('market   ', state.collateralToken, '→', state.loanToken)
console.log('HF       ', report.healthFactor)
console.log('debt     ', report.debtAssets)
console.log('liq price', report.liquidationPrice)
console.log('buffer   ', report.bufferBps, 'bps')
