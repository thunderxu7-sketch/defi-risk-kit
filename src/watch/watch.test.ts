import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'

import type { LendingAdapter } from '../adapters/types'
import { WAD } from '../core/fixed-point'
import type { MarketRef, MarketState, Position } from '../core/types'
import { INFINITE_HEALTH } from '../health/compute'
import { DEFAULT_THRESHOLDS, classify, watchHealth } from './watch'

const REF: MarketRef = { chainId: 1, protocol: 'morpho-blue', marketId: '0xabc0' }
const USER = '0x3333333333333333333333333333333333333333' as const

describe('classify', () => {
  const hf = (x: bigint) => ({ healthFactor: x })
  it('maps HF ranges to levels with exact boundaries', () => {
    expect(classify(hf(INFINITE_HEALTH))).toBe('safe')
    expect(classify(hf(WAD))).toBe('danger') // 1.00 < 1.05
    expect(classify(hf(DEFAULT_THRESHOLDS.danger))).toBe('warn') // exactly 1.05 → not danger
    expect(classify(hf((11n * WAD) / 10n))).toBe('warn')
    expect(classify(hf(DEFAULT_THRESHOLDS.warn))).toBe('safe') // exactly 1.20 → safe
    expect(classify(hf(2n * WAD))).toBe('safe')
  })
})

describe('watchHealth', () => {
  const E18 = 10n ** 18n
  const E36 = 10n ** 36n

  const state: MarketState = {
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
  }
  const position: Position = {
    user: USER,
    market: REF,
    collateral: 10n * E18,
    borrowShares: 15_500n * E18, // HF ≈ 1.032 → 'danger'
    supplyShares: 0n,
  }

  const stubAdapter: LendingAdapter = {
    protocol: 'test',
    paradigm: 'isolated',
    getMarket: () => Promise.resolve(state),
    getPosition: () => Promise.resolve(position),
    accrue: (s, to) => ({ ...s, lastAccrual: Math.max(s.lastAccrual, to) }),
    toAssets: (shares) => shares,
    toShares: (assets) => assets,
    buildCalls: { repay: () => [], withdrawCollateral: () => [], approveIfNeeded: () => [] },
  }

  it('emits reports on an interval and stops cleanly', async () => {
    const events: string[] = []
    const stop = watchHealth({} as PublicClient, [{ adapter: stubAdapter, user: USER, ref: REF }], {
      intervalMs: 5,
      now: () => 1_000_100,
      onReport: (report, level) => {
        events.push(level)
        expect(report.asOf).toBe(1_000_100)
      },
    })
    await new Promise((r) => setTimeout(r, 40))
    stop()
    const count = events.length
    expect(count).toBeGreaterThanOrEqual(2)
    expect(events.every((l) => l === 'danger')).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(events.length).toBe(count) // no emissions after stop
  })

  it('routes per-target failures to onError and keeps running', async () => {
    const failing: LendingAdapter = {
      ...stubAdapter,
      getMarket: () => Promise.reject(new Error('rpc down')),
    }
    const errors: unknown[] = []
    const reports: string[] = []
    const stop = watchHealth(
      {} as PublicClient,
      [
        { adapter: failing, user: USER, ref: REF },
        { adapter: stubAdapter, user: USER, ref: REF },
      ],
      {
        intervalMs: 5,
        now: () => 1_000_100,
        onReport: (_r, level) => reports.push(level),
        onError: (e) => errors.push(e),
      },
    )
    await new Promise((r) => setTimeout(r, 25))
    stop()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(reports.length).toBeGreaterThanOrEqual(1)
  })
})
