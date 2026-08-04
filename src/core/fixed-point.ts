/**
 * Fixed-point bigint math. All health/interest computations in this kit are
 * bigint-only — floating point is never used for on-chain quantities.
 *
 * Rounding policy (mirrors mainstream lending implementations):
 *  - debt is rounded UP (conservative for the protocol),
 *  - collateral capacity is rounded DOWN.
 * Helpers therefore come in explicit Down/Up pairs; callers pick direction.
 */

export const WAD = 10n ** 18n
export const RAY = 10n ** 27n
/** Morpho-convention oracle price scale (before token-decimal adjustment). */
export const ORACLE_PRICE_SCALE = 10n ** 36n
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n

/** floor(x * y / d). Throws on division by zero. */
export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('mulDivDown: division by zero')
  return (x * y) / d
}

/** ceil(x * y / d). Throws on division by zero. */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('mulDivUp: division by zero')
  return (x * y + (d - 1n)) / d
}

export function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, WAD)
}

export function wMulUp(x: bigint, y: bigint): bigint {
  return mulDivUp(x, y, WAD)
}

export function wDivDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, WAD, y)
}

export function wDivUp(x: bigint, y: bigint): bigint {
  return mulDivUp(x, WAD, y)
}

/**
 * Second-order Taylor approximation of continuously compounded interest,
 * matching Morpho Blue's `wTaylorCompounded`:
 *   e^(rate*t) - 1 ≈ rt + (rt)^2/2 + (rt)^3/6, all WAD-scaled.
 * Used by adapters to advance interest off-chain between on-chain accruals.
 */
export function wTaylorCompounded(ratePerSecond: bigint, elapsedSeconds: bigint): bigint {
  const firstTerm = ratePerSecond * elapsedSeconds
  const secondTerm = mulDivDown(firstTerm, firstTerm, 2n * WAD)
  const thirdTerm = mulDivDown(secondTerm, firstTerm, 3n * WAD)
  return firstTerm + secondTerm + thirdTerm
}

/** Convert bps (1e4 = 100%) to a WAD fraction. */
export function bpsToWad(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0)
    throw new RangeError('bpsToWad: bps must be a non-negative integer')
  return (BigInt(bps) * WAD) / 10_000n
}
