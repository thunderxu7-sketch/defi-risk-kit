import { parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'

import type { MarketState } from '../core/types'

export interface ReferenceQuote {
  /** Reference price scaled to the market's `oracleScale`. */
  price: bigint
  /** Unix seconds of the reference's last update, when the source knows it. */
  updatedAt?: number
}

/** Pluggable reference price source used for oracle drift checks. */
export interface ReferenceSource {
  id: string
  quote(client: PublicClient, state: MarketState): Promise<ReferenceQuote>
}

/** Fixed reference — for tests, manual sanity checks, or externally-computed prices. */
export function manualReference(price: bigint, updatedAt?: number): ReferenceSource {
  return {
    id: 'manual',
    quote: () => Promise.resolve({ price, ...(updatedAt !== undefined ? { updatedAt } : {}) }),
  }
}

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])

export interface ChainlinkFeedConfig {
  /** Chainlink aggregator (or compatible) quoting 1 collateral token in loan currency. */
  feed: Address
  /**
   * Optional override for scaling the feed answer to the market's oracleScale.
   * Default assumes the Morpho convention: scaled = answer * 10^(36 + loanDec − collateralDec − feedDec).
   */
  scale?: (answer: bigint, feedDecimals: number, state: MarketState) => bigint
}

/**
 * Chainlink-style reference. Assumes the feed quotes the collateral asset in
 * the loan asset's currency; pass `scale` when your feed pair differs.
 */
export function chainlinkFeed(config: ChainlinkFeedConfig): ReferenceSource {
  return {
    id: `chainlink:${config.feed}`,
    async quote(client, state) {
      const [round, feedDecimals] = await Promise.all([
        client.readContract({
          address: config.feed,
          abi: aggregatorAbi,
          functionName: 'latestRoundData',
        }),
        client.readContract({ address: config.feed, abi: aggregatorAbi, functionName: 'decimals' }),
      ])
      const [, answer, , updatedAt] = round
      if (answer <= 0n) throw new Error(`chainlink feed ${config.feed}: non-positive answer`)
      const price = config.scale
        ? config.scale(answer, feedDecimals, state)
        : defaultScale(answer, feedDecimals, state)
      return { price, updatedAt: Number(updatedAt) }
    },
  }
}

function defaultScale(answer: bigint, feedDecimals: number, state: MarketState): bigint {
  const exponent = 36 + state.loanDecimals - state.collateralDecimals - feedDecimals
  if (exponent >= 0) return answer * 10n ** BigInt(exponent)
  return answer / 10n ** BigInt(-exponent)
}
