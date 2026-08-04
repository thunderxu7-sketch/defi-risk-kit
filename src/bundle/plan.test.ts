import { describe, expect, it } from 'vitest'

import { morphoBlue } from '../adapters/morpho-blue'
import type { LendingAdapter } from '../adapters/types'
import { WAD } from '../core/fixed-point'
import type { MarketRef, MarketState, Position } from '../core/types'
import { assembleDeleverage, planDeleverage } from './plan'
import { staticQuote } from './quoters'

const REF: MarketRef = { chainId: 1, protocol: 'morpho-blue', marketId: '0xabc0' }
const A = '0x1111111111111111111111111111111111111111' as const // loan
const B = '0x2222222222222222222222222222222222222222' as const // collateral
const USER = '0x3333333333333333333333333333333333333333' as const
const ROUTER = '0x4444444444444444444444444444444444444444' as const

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
    repay: () => [{ to: A, value: 0n, data: '0x01' }],
    withdrawCollateral: () => [{ to: B, value: 0n, data: '0x02' }],
    approveIfNeeded: (token) => [{ to: token, value: 0n, data: '0x03' }],
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

function mkPosition(overrides: Partial<Position> = {}): Position {
  return {
    user: USER,
    market: REF,
    collateral: 10n * E18,
    borrowShares: 10_000n * E18,
    supplyShares: 0n,
    ...overrides,
  }
}

describe('planDeleverage — golden vector (close 50%, slippage 1%)', () => {
  const plan = planDeleverage(identityAdapter, mkPosition(), mkState(), {
    closeBps: 5000,
    slippageBps: 100,
  })

  it('repay and withdrawal amounts', () => {
    expect(plan.repayAssets).toBe(5000n * E18)
    // 5000 loan / 2000 = 2.5 collateral, +1% buffer = 2.525
    expect(plan.withdrawCollateral).toBe((2525n * E18) / 1000n)
    expect(plan.swapRequest.minAmountOut).toBe(5000n * E18)
    expect(plan.swapRequest.tokenIn).toBe(B)
    expect(plan.swapRequest.tokenOut).toBe(A)
  })

  it('expected health improves: 1.6 → 2.392', () => {
    expect(plan.before.healthFactor).toBe((16n * WAD) / 10n)
    // after: collateral 7.475, value 14950, capacity 11960, debt 5000
    expect(plan.after.debtAssets).toBe(5000n * E18)
    expect(plan.after.collateral).toBe((7475n * E18) / 1000n)
    expect(plan.after.healthFactor).toBe((2392n * WAD) / 1000n)
    expect(plan.after.healthFactor > plan.before.healthFactor).toBe(true)
  })

  it('mid-step stays healthy for a comfortable position', () => {
    expect(plan.midStepHealthy).toBe(true)
  })
})

describe('planDeleverage — near-liquidation position', () => {
  it('flags the naive ordering as unsafe but still improves health', () => {
    // HF before = 16000/15500 ≈ 1.032
    const plan = planDeleverage(
      identityAdapter,
      mkPosition({ borrowShares: 15_500n * E18 }),
      mkState(),
      { closeBps: 3000, slippageBps: 100 },
    )
    expect(plan.before.healthFactor < (11n * WAD) / 10n).toBe(true)
    expect(plan.midStepHealthy).toBe(false)
    expect(plan.after.healthFactor > plan.before.healthFactor).toBe(true)
  })
})

describe('planDeleverage — guards', () => {
  it('rejects invalid bps and empty debt', () => {
    expect(() =>
      planDeleverage(identityAdapter, mkPosition(), mkState(), { closeBps: 0, slippageBps: 0 }),
    ).toThrow(RangeError)
    expect(() =>
      planDeleverage(identityAdapter, mkPosition(), mkState(), {
        closeBps: 10_001,
        slippageBps: 0,
      }),
    ).toThrow(RangeError)
    expect(() =>
      planDeleverage(identityAdapter, mkPosition({ borrowShares: 0n }), mkState(), {
        closeBps: 1000,
        slippageBps: 0,
      }),
    ).toThrow(/no debt/)
  })

  it('rejects plans that need more collateral than the position holds', () => {
    expect(() =>
      planDeleverage(identityAdapter, mkPosition({ collateral: 5n * E18 }), mkState(), {
        closeBps: 10_000,
        slippageBps: 9000,
      }),
    ).toThrow(/exceeds collateral/)
  })
})

describe('assembleDeleverage — ordering', () => {
  it('approvals → withdraw → swap → repay, against real morpho encoding', async () => {
    const adapter = morphoBlue()
    const native = {
      loanToken: A,
      collateralToken: B,
      oracle: ROUTER,
      irm: ROUTER,
      lltv: (8n * WAD) / 10n,
    }
    const state = mkState({ native })
    // Identity plan gives deterministic numbers; morpho adapter provides real call encoding:
    const idPlan = planDeleverage(identityAdapter, mkPosition(), mkState({ native }), {
      closeBps: 5000,
      slippageBps: 100,
    })
    const swapCall = await staticQuote({ to: ROUTER, value: 0n, data: '0xbeef' }).buildSwap(
      {} as never,
      idPlan.swapRequest,
    )
    const calls = assembleDeleverage(adapter, state, idPlan, { swapCall })
    expect(calls).toHaveLength(5)
    expect(calls[0]?.to).toBe(B) // approve collateral → router
    expect(calls[1]?.to).toBe(A) // approve loan → morpho core
    expect(calls[2]?.to).toBe('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb') // withdrawCollateral
    expect(calls[3]?.to).toBe(ROUTER) // swap
    expect(calls[4]?.to).toBe('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb') // repay
  })
})
