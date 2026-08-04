import type { PublicClient } from 'viem'

import type { MarketState, OracleHealth } from '../core/types'
import type { ReferenceSource } from './sources'

export interface CheckOracleOptions {
  /** Reference source to measure drift against. Without one, drift is 0 and
   *  staleness can only come from `maxAgeSeconds` vs the state's accrual time. */
  reference?: ReferenceSource
  /** Max acceptable reference age in seconds before flagging `stale`. */
  maxStalenessSeconds?: number
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: number
}

/**
 * Sanity-check a market's oracle price: absolute drift (bps) vs. a reference
 * source and reference staleness. The market price itself comes from the
 * adapter-normalized `MarketState` so all scales line up by construction.
 */
export async function checkOracle(
  client: PublicClient,
  state: MarketState,
  options: CheckOracleOptions = {},
): Promise<OracleHealth> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const price = state.oraclePrice

  if (!options.reference) {
    return {
      market: state.ref,
      price,
      scale: state.oracleScale,
      driftBps: 0,
      referenceSource: 'none',
      stale: false,
      asOf: now,
    }
  }

  const quote = await options.reference.quote(client, state)
  if (quote.price <= 0n)
    throw new Error(`oracle reference ${options.reference.id}: non-positive price`)

  const delta = price > quote.price ? price - quote.price : quote.price - price
  const driftBps = Number((delta * 10_000n) / quote.price)

  const stale =
    options.maxStalenessSeconds !== undefined &&
    quote.updatedAt !== undefined &&
    now - quote.updatedAt > options.maxStalenessSeconds

  return {
    market: state.ref,
    price,
    scale: state.oracleScale,
    driftBps,
    referenceSource: options.reference.id,
    stale,
    asOf: now,
  }
}
