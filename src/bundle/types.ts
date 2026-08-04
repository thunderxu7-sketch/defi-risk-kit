import type { Address, PublicClient } from 'viem'

import type { Call, MarketRef, Position } from '../core/types'

/** What a swap step must achieve inside a deleverage bundle. */
export interface SwapRequest {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  /** Swap must return at least this much tokenOut or the bundle should revert. */
  minAmountOut: bigint
  /** Who receives tokenOut (the executor context that pays the repay). */
  recipient: Address
}

/** Pluggable swap-call builder (Uniswap, aggregator, or pre-computed). */
export interface SwapQuoter {
  id: string
  buildSwap(client: PublicClient, request: SwapRequest): Promise<Call>
}

/** Pure output of planDeleverage — all amounts, expectations, and the swap spec. */
export interface DeleveragePlan {
  position: Position
  market: MarketRef
  /** Loan assets to repay (closeBps of current debt, rounded up). */
  repayAssets: bigint
  /** Collateral to withdraw and sell, incl. the slippage buffer. */
  withdrawCollateral: bigint
  /** The swap the bundle needs (minAmountOut == repayAssets). */
  swapRequest: SwapRequest
  /** True when the position stays healthy between withdrawal and repay —
   *  i.e. the naive withdraw→swap→repay ordering is executable without an
   *  executor callback. Near-liquidation positions are typically false. */
  midStepHealthy: boolean
  before: { healthFactor: bigint; debtAssets: bigint; collateral: bigint }
  /** Expected post-bundle values assuming the swap fills at minAmountOut. */
  after: { healthFactor: bigint; debtAssets: bigint; collateral: bigint }
  /** Unix seconds the plan was computed for (accrual advanced to this time). */
  asOf: number
}

/** An executor strategy turns ordered calls into the shape one on-chain
 *  executor consumes (single wrapped call, callback payload, etc.). */
export interface Executor {
  id: string
  wrap(calls: Call[]): Call[]
}
