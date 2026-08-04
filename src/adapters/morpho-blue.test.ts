import { describe, expect, it } from 'vitest'

import { WAD, wMulDown, wTaylorCompounded } from '../core/fixed-point'
import type { MarketRef, MarketState } from '../core/types'
import { VIRTUAL_ASSETS, VIRTUAL_SHARES, morphoBlue } from './morpho-blue'

const REF: MarketRef = { chainId: 1, protocol: 'morpho-blue', marketId: '0xabc0' }
const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const

const adapter = morphoBlue()

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
    oraclePrice: 0n,
    oracleScale: 10n ** 36n,
    fee: 0n,
    ...overrides,
  }
}

describe('morpho share math (virtual offsets)', () => {
  it('empty market: assets convert at the 1e6 virtual ratio', () => {
    const s = mkState()
    expect(adapter.toShares(100n, s, 'borrow', 'down')).toBe(100n * VIRTUAL_SHARES)
    expect(adapter.toAssets(100n * VIRTUAL_SHARES, s, 'borrow', 'down')).toBe(
      (100n * VIRTUAL_SHARES * VIRTUAL_ASSETS) / VIRTUAL_SHARES,
    )
  })

  it('rounding direction is explicit and differs at boundaries', () => {
    const s = mkState({ totalBorrowAssets: 1000n, totalBorrowShares: 3000n })
    // assets = shares * (1000+1) / (3000+1e6)
    const shares = 10n
    const down = adapter.toAssets(shares, s, 'borrow', 'down')
    const up = adapter.toAssets(shares, s, 'borrow', 'up')
    expect(down).toBe(0n) // 10*1001/1003000 = 0.00998... → 0
    expect(up).toBe(1n) //                        → 1
  })

  it('borrow and supply sides use their own totals', () => {
    const s = mkState({
      totalBorrowAssets: 2_000_000n,
      totalBorrowShares: 1_000_000n,
      totalSupplyAssets: 1_000_000n,
      totalSupplyShares: 2_000_000n,
    })
    // borrow: 1e6*(2_000_001)/(2e6) = 1_000_000 ; supply: 1e6*(1_000_001)/(3e6) = 333_333
    expect(adapter.toAssets(1_000_000n, s, 'borrow', 'down')).toBe(1_000_000n)
    expect(adapter.toAssets(1_000_000n, s, 'supply', 'down')).toBe(333_333n)
  })
})

describe('accrue (off-chain interest)', () => {
  it('no-op when time does not advance or nothing is borrowed', () => {
    const s = mkState({ totalBorrowAssets: 0n, borrowRatePerSecond: WAD })
    expect(adapter.accrue(s, 999).lastAccrual).toBe(1_000_000)
    expect(adapter.accrue(s, 2_000_000).totalBorrowAssets).toBe(0n)
  })

  it('pinned vector: rate=1 WAD/s, 1s, borrow=3_000_000 wei', () => {
    // taylor(WAD, 1) = 1e18 + 5e17 + 1.66..e17 = 1_666_666_666_666_666_666
    expect(wTaylorCompounded(WAD, 1n)).toBe(1_666_666_666_666_666_666n)
    const s = mkState({
      totalBorrowAssets: 3_000_000n,
      totalSupplyAssets: 3_000_000n,
      totalSupplyShares: 3_000_000n,
      borrowRatePerSecond: WAD,
    })
    const accrued = adapter.accrue(s, 1_000_001)
    // interest = floor(3_000_000 * 1.666..) = 4_999_999
    expect(accrued.totalBorrowAssets).toBe(3_000_000n + 4_999_999n)
    expect(accrued.totalSupplyAssets).toBe(3_000_000n + 4_999_999n)
    expect(accrued.totalSupplyShares).toBe(3_000_000n) // fee = 0 → no shares minted
    expect(accrued.lastAccrual).toBe(1_000_001)
  })

  it('interest matches wMulDown(totalBorrow, taylor) structurally', () => {
    const rate = WAD / 1_000_000_000n
    const s = mkState({
      totalBorrowAssets: 123_456n * WAD,
      totalSupplyAssets: 200_000n * WAD,
      totalSupplyShares: 200_000n * WAD,
      borrowRatePerSecond: rate,
    })
    const dt = 3600
    const accrued = adapter.accrue(s, 1_000_000 + dt)
    const expected = wMulDown(s.totalBorrowAssets, wTaylorCompounded(rate, BigInt(dt)))
    expect(accrued.totalBorrowAssets - s.totalBorrowAssets).toBe(expected)
  })

  it('protocol fee mints supply shares', () => {
    const s = mkState({
      totalBorrowAssets: 1_000_000n * WAD,
      totalSupplyAssets: 1_000_000n * WAD,
      totalSupplyShares: 1_000_000n * WAD,
      borrowRatePerSecond: WAD / 1_000_000n,
      fee: WAD / 10n, // 10%
    })
    const accrued = adapter.accrue(s, 1_000_000 + 60)
    expect(accrued.totalSupplyShares > s.totalSupplyShares).toBe(true)
    // both totals still grew by the same interest
    expect(accrued.totalBorrowAssets - s.totalBorrowAssets).toBe(
      accrued.totalSupplyAssets - s.totalSupplyAssets,
    )
  })

  it('is pure: input state is not mutated', () => {
    const s = mkState({
      totalBorrowAssets: 1000n,
      borrowRatePerSecond: WAD,
    })
    adapter.accrue(s, 2_000_000)
    expect(s.totalBorrowAssets).toBe(1000n)
    expect(s.lastAccrual).toBe(1_000_000)
  })
})

describe('buildCalls', () => {
  const NATIVE = {
    loanToken: A,
    collateralToken: B,
    oracle: '0x4444444444444444444444444444444444444444',
    irm: '0x5555555555555555555555555555555555555555',
    lltv: (8n * WAD) / 10n,
  }
  const USER = '0x3333333333333333333333333333333333333333' as const
  const position = { user: USER, market: REF, collateral: 0n, borrowShares: 0n, supplyShares: 0n }

  it('throws a clear error when state.native is missing', () => {
    expect(() => adapter.buildCalls.repay(position, mkState(), 1n)).toThrow(/native/)
  })

  it('encodes repay and withdrawCollateral against the deployment address', () => {
    const state = mkState({ native: NATIVE })
    const [repay] = adapter.buildCalls.repay(position, state, 5n)
    const [withdraw] = adapter.buildCalls.withdrawCollateral(position, state, 7n)
    expect(repay?.to).toBe('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
    expect(withdraw?.to).toBe('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
    expect(repay?.data.startsWith('0x')).toBe(true)
    expect(repay?.value).toBe(0n)
  })

  it('approveIfNeeded targets the token', () => {
    const [call] = adapter.buildCalls.approveIfNeeded(A, B, 123n)
    expect(call?.to).toBe(A)
  })

  it('unknown chain deployment throws', () => {
    const state = mkState({ native: NATIVE })
    const foreign = { ...position, market: { ...REF, chainId: 999_999 } }
    expect(() => adapter.buildCalls.repay(foreign, state, 1n)).toThrow(/chainId 999999/)
  })
})
