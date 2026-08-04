import { encodeFunctionData, parseAbi, zeroAddress } from 'viem'
import type { Address, PublicClient } from 'viem'

import {
  ORACLE_PRICE_SCALE,
  mulDivDown,
  mulDivUp,
  wMulDown,
  wTaylorCompounded,
} from '../core/fixed-point'
import type { Call, MarketRef, MarketState, Position } from '../core/types'
import type { LendingAdapter, Rounding, ShareKind } from './types'

/** Morpho Blue share-math virtual offsets (SharesMathLib). */
export const VIRTUAL_SHARES = 1_000_000n
export const VIRTUAL_ASSETS = 1n

/** Morpho Blue market params as stored in `MarketState.native`. */
export interface MorphoMarketParams {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export interface MorphoBlueDeployments {
  [chainId: number]: { morpho: Address }
}

/** Canonical Morpho Blue singleton (same address on Ethereum mainnet and Base). */
const CANONICAL_MORPHO: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'

export const DEFAULT_DEPLOYMENTS: MorphoBlueDeployments = {
  1: { morpho: CANONICAL_MORPHO },
  8453: { morpho: CANONICAL_MORPHO },
}

const morphoAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }',
  'function idToMarketParams(bytes32 id) view returns (MarketParams marketParams)',
  'function market(bytes32 id) view returns (Market m)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function repay(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)',
  'function withdrawCollateral(MarketParams marketParams, uint256 assets, address onBehalf, address receiver)',
])

const irmAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }',
  'function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)',
])

const oracleAbi = parseAbi(['function price() view returns (uint256)'])

const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

function nativeParams(state: MarketState): MorphoMarketParams {
  const params = state.native as MorphoMarketParams | undefined
  if (!params || !params.loanToken) {
    throw new Error(
      'morpho-blue: MarketState.native is missing MarketParams — the state must come from morphoBlue().getMarket',
    )
  }
  return params
}

/** shares → assets with Morpho virtual offsets. */
function sharesToAssets(
  shares: bigint,
  totalAssets: bigint,
  totalShares: bigint,
  rounding: Rounding,
): bigint {
  const div = rounding === 'up' ? mulDivUp : mulDivDown
  return div(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)
}

/** assets → shares with Morpho virtual offsets. */
function assetsToShares(
  assets: bigint,
  totalAssets: bigint,
  totalShares: bigint,
  rounding: Rounding,
): bigint {
  const div = rounding === 'up' ? mulDivUp : mulDivDown
  return div(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)
}

function totalsFor(state: MarketState, kind: ShareKind): { assets: bigint; shares: bigint } {
  return kind === 'borrow'
    ? { assets: state.totalBorrowAssets, shares: state.totalBorrowShares }
    : { assets: state.totalSupplyAssets, shares: state.totalSupplyShares }
}

export interface MorphoBlueConfig {
  /** Per-chain deployment overrides/additions; merged over DEFAULT_DEPLOYMENTS. */
  deployments?: MorphoBlueDeployments
}

/**
 * Morpho-Blue-style adapter. Works against the canonical Morpho Blue singleton
 * and against any Morpho-Blue-compatible deployment via `deployments` overrides.
 *
 * Semantics documented per LendingAdapter contract:
 *  - share→asset conversion uses Morpho SharesMathLib virtual offsets
 *    (VIRTUAL_SHARES=1e6, VIRTUAL_ASSETS=1);
 *  - `borrowRatePerSecond` is the IRM's `borrowRateView` (already WAD/second);
 *  - `oracleScale` is the Morpho constant 1e36 (oracle embeds token decimals);
 *  - accrual mirrors Morpho `_accrueInterest`: taylor-compounded interest added
 *    to both borrow and supply totals, protocol fee minted as supply shares.
 */
export function morphoBlue(config: MorphoBlueConfig = {}): LendingAdapter {
  const deployments: MorphoBlueDeployments = { ...DEFAULT_DEPLOYMENTS, ...config.deployments }

  function morphoAddress(chainId: number): Address {
    const d = deployments[chainId]
    if (!d) throw new Error(`morpho-blue: no deployment configured for chainId ${chainId}`)
    return d.morpho
  }

  const adapter: LendingAdapter = {
    protocol: 'morpho-blue',
    paradigm: 'isolated',

    async getMarket(client: PublicClient, ref: MarketRef): Promise<MarketState> {
      const morpho = morphoAddress(ref.chainId)
      const [params, market] = await Promise.all([
        client.readContract({
          address: morpho,
          abi: morphoAbi,
          functionName: 'idToMarketParams',
          args: [ref.marketId],
        }),
        client.readContract({
          address: morpho,
          abi: morphoAbi,
          functionName: 'market',
          args: [ref.marketId],
        }),
      ])
      if (params.loanToken === zeroAddress) {
        throw new Error(`morpho-blue: market ${ref.marketId} not found on chain ${ref.chainId}`)
      }
      const [price, rate, loanDecimals, collateralDecimals] = await Promise.all([
        params.oracle === zeroAddress
          ? Promise.resolve(0n)
          : client.readContract({ address: params.oracle, abi: oracleAbi, functionName: 'price' }),
        params.irm === zeroAddress
          ? Promise.resolve(0n)
          : client.readContract({
              address: params.irm,
              abi: irmAbi,
              functionName: 'borrowRateView',
              args: [params, market],
            }),
        client.readContract({ address: params.loanToken, abi: erc20Abi, functionName: 'decimals' }),
        client.readContract({
          address: params.collateralToken,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
      ])
      return {
        ref,
        loanToken: params.loanToken,
        collateralToken: params.collateralToken,
        loanDecimals,
        collateralDecimals,
        totalSupplyAssets: market.totalSupplyAssets,
        totalSupplyShares: market.totalSupplyShares,
        totalBorrowAssets: market.totalBorrowAssets,
        totalBorrowShares: market.totalBorrowShares,
        lltv: params.lltv,
        borrowRatePerSecond: rate,
        lastAccrual: Number(market.lastUpdate),
        oraclePrice: price,
        oracleScale: ORACLE_PRICE_SCALE,
        fee: market.fee,
        native: {
          loanToken: params.loanToken,
          collateralToken: params.collateralToken,
          oracle: params.oracle,
          irm: params.irm,
          lltv: params.lltv,
        } satisfies MorphoMarketParams,
      }
    },

    async getPosition(client: PublicClient, user: Address, ref: MarketRef): Promise<Position> {
      const morpho = morphoAddress(ref.chainId)
      const [supplyShares, borrowShares, collateral] = await client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: 'position',
        args: [ref.marketId, user],
      })
      return { user, market: ref, collateral, borrowShares, supplyShares }
    },

    accrue(state: MarketState, to: number): MarketState {
      if (to <= state.lastAccrual || state.totalBorrowAssets === 0n) {
        return { ...state, lastAccrual: Math.max(state.lastAccrual, to) }
      }
      const elapsed = BigInt(to - state.lastAccrual)
      const interest = wMulDown(
        state.totalBorrowAssets,
        wTaylorCompounded(state.borrowRatePerSecond, elapsed),
      )
      let totalSupplyShares = state.totalSupplyShares
      const totalSupplyAssets = state.totalSupplyAssets + interest
      if (state.fee > 0n && interest > 0n) {
        const feeAmount = wMulDown(interest, state.fee)
        // Fee shares are minted against the pre-fee supply total, mirroring Morpho.
        const feeShares = assetsToShares(
          feeAmount,
          totalSupplyAssets - feeAmount,
          state.totalSupplyShares,
          'down',
        )
        totalSupplyShares += feeShares
      }
      return {
        ...state,
        totalBorrowAssets: state.totalBorrowAssets + interest,
        totalSupplyAssets,
        totalSupplyShares,
        lastAccrual: to,
      }
    },

    toAssets(shares: bigint, state: MarketState, kind: ShareKind, rounding: Rounding): bigint {
      const { assets, shares: totalShares } = totalsFor(state, kind)
      return sharesToAssets(shares, assets, totalShares, rounding)
    },

    toShares(assets: bigint, state: MarketState, kind: ShareKind, rounding: Rounding): bigint {
      const { assets: totalAssets, shares } = totalsFor(state, kind)
      return assetsToShares(assets, totalAssets, shares, rounding)
    },

    buildCalls: {
      repay(position: Position, state: MarketState, assets: bigint): Call[] {
        const params = nativeParams(state)
        const morpho = morphoAddress(position.market.chainId)
        return [
          {
            to: morpho,
            value: 0n,
            data: encodeFunctionData({
              abi: morphoAbi,
              functionName: 'repay',
              args: [params, assets, 0n, position.user, '0x'],
            }),
          },
        ]
      },

      withdrawCollateral(position: Position, state: MarketState, assets: bigint): Call[] {
        const params = nativeParams(state)
        const morpho = morphoAddress(position.market.chainId)
        return [
          {
            to: morpho,
            value: 0n,
            data: encodeFunctionData({
              abi: morphoAbi,
              functionName: 'withdrawCollateral',
              args: [params, assets, position.user, position.user],
            }),
          },
        ]
      },

      /** Encodes an ERC-20 approve unconditionally; whether it is needed is
       *  decided by the caller (simulate/preflight, landing in M2). */
      approveIfNeeded(token: Address, spender: Address, amount: bigint): Call[] {
        return [
          {
            to: token,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [spender, amount],
            }),
          },
        ]
      },
    },
  }

  return adapter
}
