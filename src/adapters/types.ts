import type { Address, PublicClient } from 'viem'

import type { Call, MarketRef, MarketState, Position } from '../core/types'

export type Rounding = 'up' | 'down'
export type ShareKind = 'borrow' | 'supply'

/**
 * Protocol adapter contract. Adapters are read/compute/encode only:
 * they never sign, never broadcast, and never decide.
 *
 * Implementations must document:
 *  - the exact share→asset conversion (incl. virtual shares/assets offsets),
 *  - the native rate model normalization to `borrowRatePerSecond` (WAD),
 *  - rounding directions (debt UP, collateral capacity DOWN).
 */
export interface LendingAdapter {
  readonly protocol: string
  readonly paradigm: 'isolated' | 'pooled'

  getMarket(client: PublicClient, ref: MarketRef): Promise<MarketState>
  getPosition(client: PublicClient, user: Address, ref: MarketRef): Promise<Position>

  /** Pure function: advance interest from `state.lastAccrual` to `to` (unix seconds). */
  accrue(state: MarketState, to: number): MarketState

  /** Share/asset conversion against a (possibly accrued) state. */
  toAssets(shares: bigint, state: MarketState, kind: ShareKind, rounding: Rounding): bigint
  toShares(assets: bigint, state: MarketState, kind: ShareKind, rounding: Rounding): bigint

  /** Calldata primitives. Ordering/composition is the caller's job (see bundle/). */
  buildCalls: {
    repay(position: Position, state: MarketState, assets: bigint): Call[]
    withdrawCollateral(position: Position, state: MarketState, assets: bigint): Call[]
    approveIfNeeded(token: Address, spender: Address, amount: bigint): Call[]
  }
}

/** Per-chain deployment addresses an adapter needs (protocol core, helpers). */
export interface AdapterDeployment {
  chainId: number
  addresses: Record<string, Address>
}
