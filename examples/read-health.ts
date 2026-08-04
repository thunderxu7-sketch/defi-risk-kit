// pnpm dlx tsx examples/read-health.ts
// Reads a real Base Morpho market and computes an exact, accrued health report
// for the position held by USER_ADDRESS.
import { createPublicClient, getAddress, http } from 'viem'

import { computeHealth, morphoBlue } from '../src/index'
import type { MarketRef } from '../src/index'

const client = createPublicClient({ transport: http('https://mainnet.base.org') })
const adapter = morphoBlue()
const rawUser = process.env.USER_ADDRESS
if (!rawUser) {
  throw new Error('USER_ADDRESS is required, e.g. USER_ADDRESS=0x...')
}
const user = getAddress(rawUser)
const ref: MarketRef = {
  chainId: 8453,
  protocol: 'morpho-blue',
  // cbBTC/USDC on Base
  marketId: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836',
}

const state = await adapter.getMarket(client, ref)
const position = await adapter.getPosition(client, user, ref)
const report = computeHealth(adapter, position, state, { at: Math.floor(Date.now() / 1000) })

console.log('user     ', position.user)
console.log('market   ', state.collateralToken, '→', state.loanToken)
console.log('collateral', position.collateral)
console.log('borrow shares', position.borrowShares)
console.log('HF       ', report.healthFactor)
console.log('debt     ', report.debtAssets)
console.log('liq price', report.liquidationPrice)
console.log('buffer   ', report.bufferBps, 'bps')
