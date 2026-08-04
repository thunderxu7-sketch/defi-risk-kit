import type { Address } from 'viem'

import { WAD, mulDivDown, mulDivUp, wDivDown, wMulDown } from '../core/fixed-point'
import type { Call, MarketState, Position } from '../core/types'
import type { LendingAdapter } from '../adapters/types'
import { INFINITE_HEALTH } from '../health/compute'
import type { DeleveragePlan } from './types'

export interface PlanDeleverageOptions {
  /** Portion of current debt to close, in bps (10000 = full close). */
  closeBps: number
  /** Extra collateral sold to absorb swap slippage/fees, in bps. */
  slippageBps: number
  /** Receiver of the swap output (defaults to the position owner). */
  recipient?: Address
  /** Unix seconds to plan at (interest accrued off-chain up to here). */
  at?: number
}

/**
 * Pure deleverage math: how much debt to repay, how much collateral to sell
 * (sized at the oracle price plus a slippage buffer), and the expected
 * position after the bundle — including whether the naive
 * withdraw→swap→repay ordering stays healthy mid-sequence.
 *
 * No I/O: pair with a SwapQuoter to obtain the swap call, then
 * `assembleDeleverage` to get the ordered Call[].
 */
export function planDeleverage(
  adapter: LendingAdapter,
  position: Position,
  state: MarketState,
  options: PlanDeleverageOptions,
): DeleveragePlan {
  const { closeBps, slippageBps } = options
  if (!Number.isInteger(closeBps) || closeBps <= 0 || closeBps > 10_000) {
    throw new RangeError('planDeleverage: closeBps must be an integer in (0, 10000]')
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new RangeError('planDeleverage: slippageBps must be an integer in [0, 10000)')
  }

  const at = options.at ?? state.lastAccrual
  const accrued = adapter.accrue(state, at)
  if (accrued.oraclePrice === 0n) throw new Error('planDeleverage: oracle price is zero')

  const debt = adapter.toAssets(position.borrowShares, accrued, 'borrow', 'up')
  if (debt === 0n) throw new Error('planDeleverage: position has no debt')

  const repayAssets = mulDivUp(debt, BigInt(closeBps), 10_000n)
  // Collateral worth repayAssets at the oracle price, rounded up…
  const collateralAtOracle = mulDivUp(repayAssets, accrued.oracleScale, accrued.oraclePrice)
  // …plus the slippage buffer.
  const withdrawCollateral = mulDivUp(collateralAtOracle, BigInt(10_000 + slippageBps), 10_000n)
  if (withdrawCollateral > position.collateral) {
    throw new Error(
      'planDeleverage: required withdrawal exceeds collateral — lower closeBps or slippageBps',
    )
  }

  const hf = (collateral: bigint, owed: bigint): bigint => {
    if (owed === 0n) return INFINITE_HEALTH
    const value = mulDivDown(collateral, accrued.oraclePrice, accrued.oracleScale)
    if (value === 0n) return 0n
    return wDivDown(wMulDown(value, accrued.lltv), owed)
  }

  const debtAfter = debt - repayAssets
  const collateralAfter = position.collateral - withdrawCollateral

  return {
    position,
    market: position.market,
    repayAssets,
    withdrawCollateral,
    swapRequest: {
      tokenIn: accrued.collateralToken,
      tokenOut: accrued.loanToken,
      amountIn: withdrawCollateral,
      minAmountOut: repayAssets,
      recipient: options.recipient ?? position.user,
    },
    // Between withdrawal and repay the debt is unchanged but collateral is reduced:
    midStepHealthy: hf(collateralAfter, debt) >= WAD,
    before: {
      healthFactor: hf(position.collateral, debt),
      debtAssets: debt,
      collateral: position.collateral,
    },
    after: {
      healthFactor: hf(collateralAfter, debtAfter),
      debtAssets: debtAfter,
      collateral: collateralAfter,
    },
    asOf: at,
  }
}

export interface AssembleOptions {
  /** The swap call obtained from a SwapQuoter for `plan.swapRequest`. */
  swapCall: Call
  /** Morpho-style core address the repay approval targets; defaults to the
   *  repay call's `to` produced by the adapter. */
  approveRepayTo?: Address
}

/**
 * Ordered naive bundle: approvals → withdraw → swap → repay.
 *
 * ⚠️ Executable as independent EOA transactions only when
 * `plan.midStepHealthy` is true; near-liquidation positions need an executor
 * contract that sources repay funds via callback (see Executor strategies —
 * the exact callback encoding is executor-specific).
 */
export function assembleDeleverage(
  adapter: LendingAdapter,
  state: MarketState,
  plan: DeleveragePlan,
  options: AssembleOptions,
): Call[] {
  const repay = adapter.buildCalls.repay(plan.position, state, plan.repayAssets)
  const withdraw = adapter.buildCalls.withdrawCollateral(
    plan.position,
    state,
    plan.withdrawCollateral,
  )
  const repayTarget = options.approveRepayTo ?? repay[0]?.to
  if (!repayTarget) throw new Error('assembleDeleverage: adapter produced no repay call')

  return [
    ...adapter.buildCalls.approveIfNeeded(
      plan.swapRequest.tokenIn,
      options.swapCall.to,
      plan.swapRequest.amountIn,
    ),
    ...adapter.buildCalls.approveIfNeeded(plan.swapRequest.tokenOut, repayTarget, plan.repayAssets),
    ...withdraw,
    options.swapCall,
    ...repay,
  ]
}
