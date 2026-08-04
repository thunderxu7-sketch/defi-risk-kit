// pnpm dlx tsx examples/plan-deleverage.ts
// Plans a 20% deleverage for a hypothetical WETH/USDC position and prints the
// ordered bundle (Uniswap V3 swap leg quoted against the real pool).
import { createPublicClient, http } from 'viem'

import { assembleDeleverage, morphoBlue, planDeleverage, uniswapV3Quoter } from '../src/index'
import type { MarketRef } from '../src/index'

const client = createPublicClient({ transport: http('https://mainnet.base.org') })
const adapter = morphoBlue()
const ref: MarketRef = {
  chainId: 8453,
  protocol: 'morpho-blue',
  marketId: '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda', // WETH/USDC
}

const state = await adapter.getMarket(client, ref)
const position = {
  user: '0x0000000000000000000000000000000000000001' as const,
  market: ref,
  collateral: 5n * 10n ** 18n, // 5 WETH
  borrowShares: state.totalBorrowShares / 10_000n,
  supplyShares: 0n,
}

const plan = planDeleverage(adapter, position, state, { closeBps: 2000, slippageBps: 100 })
console.log('HF before →', plan.before.healthFactor, ' after →', plan.after.healthFactor)
console.log('mid-step healthy:', plan.midStepHealthy)

const swapCall = await uniswapV3Quoter({ chainId: 8453, fee: 500 }).buildSwap(
  client,
  plan.swapRequest,
)
for (const [i, call] of assembleDeleverage(adapter, state, plan, { swapCall }).entries()) {
  console.log(`step ${i + 1}:`, call.to, `${call.data.slice(0, 10)}…`)
}
