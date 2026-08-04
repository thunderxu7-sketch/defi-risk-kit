// pnpm dlx tsx examples/check-oracle.ts
// Oracle drift/staleness check against a manual reference (2% below oracle).
import { createPublicClient, http } from 'viem'

import { checkOracle, manualReference, morphoBlue } from '../src/index'
import type { MarketRef } from '../src/index'

const client = createPublicClient({ transport: http('https://mainnet.base.org') })
const adapter = morphoBlue()
const ref: MarketRef = {
  chainId: 8453,
  protocol: 'morpho-blue',
  marketId: '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda', // WETH/USDC
}

const state = await adapter.getMarket(client, ref)
const health = await checkOracle(client, state, {
  reference: manualReference((state.oraclePrice * 98n) / 100n),
  maxStalenessSeconds: 3600,
})
console.log(health)
