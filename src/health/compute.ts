import { WAD, mulDivDown, wDivDown, wDivUp, wMulDown } from '../core/fixed-point'
import type { HealthReport, MarketState, Position } from '../core/types'
import type { LendingAdapter } from '../adapters/types'

/** Sentinel health factor for positions with zero debt (nothing to liquidate). */
export const INFINITE_HEALTH = 2n ** 256n - 1n

export interface ComputeHealthOptions {
  /** Unix seconds to compute at; interest is accrued off-chain up to this
   *  moment. Defaults to the state's last on-chain accrual (no projection). */
  at?: number
}

/**
 * Exact, point-in-time health of a position.
 *
 * Rounding is conservative throughout: debt converts shares→assets rounding UP,
 * collateral value and borrow capacity round DOWN — so `healthFactor` here is
 * never more optimistic than the protocol's own liquidation check.
 *
 * Edge conventions:
 *  - zero debt → healthFactor = INFINITE_HEALTH, ltv 0, liquidationPrice 0,
 *    bufferBps 10_000, maxWithdrawable = full collateral;
 *  - debt > 0 with zero collateral value → healthFactor 0, ltv INFINITE_HEALTH,
 *    liquidationPrice INFINITE_HEALTH (liquidatable at any price), bufferBps 0.
 */
export function computeHealth(
  adapter: LendingAdapter,
  position: Position,
  state: MarketState,
  options: ComputeHealthOptions = {},
): HealthReport {
  const at = options.at ?? state.lastAccrual
  const accrued = adapter.accrue(state, at)

  const debtAssets = adapter.toAssets(position.borrowShares, accrued, 'borrow', 'up')
  const collateralValue = mulDivDown(position.collateral, accrued.oraclePrice, accrued.oracleScale)
  const borrowCapacity = wMulDown(collateralValue, accrued.lltv)

  if (debtAssets === 0n) {
    return {
      position,
      healthFactor: INFINITE_HEALTH,
      ltv: 0n,
      lltv: accrued.lltv,
      debtAssets: 0n,
      collateralValue,
      liquidationPrice: 0n,
      bufferBps: 10_000,
      maxBorrowable: borrowCapacity,
      maxWithdrawable: position.collateral,
      asOf: at,
    }
  }

  const healthFactor = collateralValue === 0n ? 0n : wDivDown(borrowCapacity, debtAssets)
  const ltv = collateralValue === 0n ? INFINITE_HEALTH : wDivUp(debtAssets, collateralValue)

  // Price at which borrowCapacity(price) == debt:
  //   p* = debt * oracleScale * WAD / (collateral * lltv), rounded up (conservative).
  const liquidationPrice =
    position.collateral === 0n || accrued.lltv === 0n
      ? INFINITE_HEALTH
      : ceilDiv(debtAssets * accrued.oracleScale * WAD, position.collateral * accrued.lltv)

  const bufferBps =
    liquidationPrice === INFINITE_HEALTH || accrued.oraclePrice <= liquidationPrice
      ? 0
      : Number(((accrued.oraclePrice - liquidationPrice) * 10_000n) / accrued.oraclePrice)

  const maxBorrowable = borrowCapacity > debtAssets ? borrowCapacity - debtAssets : 0n

  // Collateral units that must stay to keep capacity >= debt, rounded up.
  const neededValue = accrued.lltv === 0n ? INFINITE_HEALTH : wDivUp(debtAssets, accrued.lltv)
  const neededCollateral =
    neededValue === INFINITE_HEALTH || accrued.oraclePrice === 0n
      ? INFINITE_HEALTH
      : ceilDiv(neededValue * accrued.oracleScale, accrued.oraclePrice)
  const maxWithdrawable =
    neededCollateral !== INFINITE_HEALTH && position.collateral > neededCollateral
      ? position.collateral - neededCollateral
      : 0n

  return {
    position,
    healthFactor,
    ltv,
    lltv: accrued.lltv,
    debtAssets,
    collateralValue,
    liquidationPrice,
    bufferBps,
    maxBorrowable,
    maxWithdrawable,
    asOf: at,
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('ceilDiv: division by zero')
  return (numerator + denominator - 1n) / denominator
}
