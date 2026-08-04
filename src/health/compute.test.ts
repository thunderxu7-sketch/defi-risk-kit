import { describe, expect, it } from 'vitest'

import type { LendingAdapter } from '../adapters/types'
import { WAD } from '../core/fixed-point'
import type { MarketRef, MarketState, Position } from '../core/types'
import { INFINITE_HEALTH, computeHealth } from './compute'

const REF: MarketRef = { chainId: 1, protocol: 'morpho-blue', marketId: '0xabc0' }
const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const
const USER = '0x3333333333333333333333333333333333333333' as const

/** Identity adapter: shares == assets, no interest. Lets every health output
 *  be pinned by hand without share-math noise (Morpho share math has its own
 *  golden vectors in morpho-blue.test.ts). */
const identityAdapter: LendingAdapter = {
  protocol: 'test',
  paradigm: 'isolated',
  getMarket: () => {
    throw new Error('unused')
  },
  getPosition: () => {
    throw new Error('unused')
  },
  accrue: (state, to) => ({ ...state, lastAccrual: Math.max(state.lastAccrual, to) }),
  toAssets: (shares) => shares,
  toShares: (assets) => assets,
  buildCalls: {
    repay: () => [],
    withdrawCollateral: () => [],
    approveIfNeeded: () => [],
  },
}

const E18 = 10n ** 18n
const E36 = 10n ** 36n

function mkState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ref: REF,
    loanToken: A,
    collateralToken: B,
    loanDecimals: 18,
    collateralDecimals: 18,
    totalSupplyAssets: 1_000_000n * E18,
    totalSupplyShares: 1_000_000n * E18,
    totalBorrowAssets: 500_000n * E18,
    totalBorrowShares: 500_000n * E18,
    lltv: (8n * WAD) / 10n, // 80%
    borrowRatePerSecond: 0n,
    lastAccrual: 1_000_000,
    oraclePrice: 2000n * E36, // 1 collateral = 2000 loan
    oracleScale: E36,
    fee: 0n,
    ...overrides,
  }
}

function mkPosition(overrides: Partial<Position> = {}): Position {
  return {
    user: USER,
    market: REF,
    collateral: 10n * E18, // 10 collateral tokens => value 20_000 loan
    borrowShares: 10_000n * E18, // identity adapter: debt = 10_000 loan
    supplyShares: 0n,
    ...overrides,
  }
}

describe('computeHealth — golden vector (10 collateral @2000, debt 10k, lltv 80%)', () => {
  const report = computeHealth(identityAdapter, mkPosition(), mkState())

  it('collateral value and debt', () => {
    expect(report.collateralValue).toBe(20_000n * E18)
    expect(report.debtAssets).toBe(10_000n * E18)
  })

  it('health factor 1.6, ltv 0.5 (HF = lltv/ltv cross-check)', () => {
    expect(report.healthFactor).toBe((16n * WAD) / 10n)
    // LTV = debt / collateral value = 10_000 / 20_000
    expect(report.ltv).toBe(WAD / 2n)
  })

  it('liquidation price 1250 and buffer 3750 bps', () => {
    expect(report.liquidationPrice).toBe(1250n * E36)
    expect(report.bufferBps).toBe(3750)
  })

  it('max borrowable 6000, max withdrawable 3.75', () => {
    expect(report.maxBorrowable).toBe(6000n * E18)
    expect(report.maxWithdrawable).toBe((375n * E18) / 100n)
  })
})

describe('computeHealth — edges', () => {
  it('zero debt → infinite health, full collateral withdrawable', () => {
    const r = computeHealth(identityAdapter, mkPosition({ borrowShares: 0n }), mkState())
    expect(r.healthFactor).toBe(INFINITE_HEALTH)
    expect(r.ltv).toBe(0n)
    expect(r.liquidationPrice).toBe(0n)
    expect(r.bufferBps).toBe(10_000)
    expect(r.maxWithdrawable).toBe(10n * E18)
    expect(r.maxBorrowable).toBe(16_000n * E18)
  })

  it('debt with zero collateral → HF 0, liquidatable at any price', () => {
    const r = computeHealth(identityAdapter, mkPosition({ collateral: 0n }), mkState())
    expect(r.healthFactor).toBe(0n)
    expect(r.ltv).toBe(INFINITE_HEALTH)
    expect(r.liquidationPrice).toBe(INFINITE_HEALTH)
    expect(r.bufferBps).toBe(0)
    expect(r.maxBorrowable).toBe(0n)
    expect(r.maxWithdrawable).toBe(0n)
  })

  it('exactly at the liquidation edge → HF 1, buffer 0', () => {
    // debt = capacity: 20_000 * 0.8 = 16_000
    const r = computeHealth(identityAdapter, mkPosition({ borrowShares: 16_000n * E18 }), mkState())
    expect(r.healthFactor).toBe(WAD)
    expect(r.liquidationPrice).toBe(2000n * E36)
    expect(r.bufferBps).toBe(0)
    expect(r.maxBorrowable).toBe(0n)
    expect(r.maxWithdrawable).toBe(0n)
  })

  it('underwater (price below liquidation) → HF < 1, buffer 0', () => {
    const r = computeHealth(
      identityAdapter,
      mkPosition(),
      mkState({ oraclePrice: 1000n * E36 }), // value 10_000, capacity 8_000 < debt 10_000
    )
    expect(r.healthFactor).toBe((8n * WAD) / 10n)
    expect(r.bufferBps).toBe(0)
    expect(r.maxBorrowable).toBe(0n)
  })

  it('defaults `at` to lastAccrual and stamps asOf', () => {
    const r = computeHealth(identityAdapter, mkPosition(), mkState())
    expect(r.asOf).toBe(1_000_000)
    const r2 = computeHealth(identityAdapter, mkPosition(), mkState(), { at: 1_000_500 })
    expect(r2.asOf).toBe(1_000_500)
  })
})
