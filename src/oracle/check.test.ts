import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'

import { WAD } from '../core/fixed-point'
import type { MarketRef, MarketState } from '../core/types'
import { checkOracle } from './check'
import { manualReference } from './sources'

const REF: MarketRef = { chainId: 1, protocol: 'morpho-blue', marketId: '0xabc0' }
const client = {} as PublicClient // sources under test never touch the client

const E36 = 10n ** 36n

function mkState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ref: REF,
    loanToken: '0x1111111111111111111111111111111111111111',
    collateralToken: '0x2222222222222222222222222222222222222222',
    loanDecimals: 18,
    collateralDecimals: 18,
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    lltv: (8n * WAD) / 10n,
    borrowRatePerSecond: 0n,
    lastAccrual: 1_000_000,
    oraclePrice: 2000n * E36,
    oracleScale: E36,
    fee: 0n,
    ...overrides,
  }
}

describe('checkOracle', () => {
  it('no reference → zero drift, not stale', async () => {
    const h = await checkOracle(client, mkState(), { now: 500 })
    expect(h.driftBps).toBe(0)
    expect(h.stale).toBe(false)
    expect(h.referenceSource).toBe('none')
    expect(h.price).toBe(2000n * E36)
  })

  it('reference 2% below oracle → ~204 bps drift (relative to reference)', async () => {
    // oracle 2000 vs ref 1960: delta 40/1960 = 2.0408% → 204 bps (floor)
    const h = await checkOracle(client, mkState(), {
      reference: manualReference(1960n * E36),
      now: 500,
    })
    expect(h.driftBps).toBe(204)
  })

  it('drift is symmetric in direction (absolute)', async () => {
    const above = await checkOracle(client, mkState({ oraclePrice: 2040n * E36 }), {
      reference: manualReference(2000n * E36),
    })
    const below = await checkOracle(client, mkState({ oraclePrice: 1960n * E36 }), {
      reference: manualReference(2000n * E36),
    })
    expect(above.driftBps).toBe(200)
    expect(below.driftBps).toBe(200)
  })

  it('flags stale references by age', async () => {
    const fresh = await checkOracle(client, mkState(), {
      reference: manualReference(2000n * E36, 990),
      maxStalenessSeconds: 60,
      now: 1000,
    })
    const stale = await checkOracle(client, mkState(), {
      reference: manualReference(2000n * E36, 100),
      maxStalenessSeconds: 60,
      now: 1000,
    })
    expect(fresh.stale).toBe(false)
    expect(stale.stale).toBe(true)
  })

  it('throws on a non-positive reference price', async () => {
    await expect(
      checkOracle(client, mkState(), { reference: manualReference(0n) }),
    ).rejects.toThrow(/non-positive/)
  })
})
