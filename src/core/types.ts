import type { Address, Hex } from 'viem'

/** Supported lending paradigms. `isolated`: per-market positions (Morpho-Blue-style).
 *  `pooled`: account-level cross-market positions (Compound-V2-style). */
export type LendingParadigm = 'isolated' | 'pooled'

export type ProtocolId = 'morpho-blue' | 'compound-v2'

/** Stable reference to one lending market on one chain. */
export interface MarketRef {
  chainId: number
  protocol: ProtocolId
  /** Protocol-native market identifier (e.g. Morpho Blue market id hash). */
  marketId: Hex
}

/**
 * Normalized snapshot of a market. Amounts stay in protocol-native share/asset
 * units; adapters document their exact semantics. All fixed-point values use
 * the scales declared here — nothing is silently rescaled.
 */
export interface MarketState {
  ref: MarketRef
  loanToken: Address
  collateralToken: Address
  /** Loan-token decimals / collateral-token decimals. */
  loanDecimals: number
  collateralDecimals: number
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  /** Liquidation LTV, WAD-scaled (1e18 = 100%). */
  lltv: bigint
  /** Borrow rate per second, WAD-scaled. Adapters normalize native rate models. */
  borrowRatePerSecond: bigint
  /** Unix seconds of the last on-chain interest accrual. */
  lastAccrual: number
  /** Oracle price of 1 unit of collateral in loan token, scaled by `oracleScale`. */
  oraclePrice: bigint
  /** Price scale (Morpho convention: 1e36 adjusted for token decimals). */
  oracleScale: bigint
  /** Protocol fee on accrued interest, WAD-scaled (0 = no fee). */
  fee: bigint
  /** Adapter-specific payload (e.g. Morpho MarketParams) that buildCalls may require.
   *  Populated by the adapter's getMarket; opaque to everything else. */
  native?: unknown
}

/** A user's position in one market (isolated) or one entry of an account (pooled). */
export interface Position {
  user: Address
  market: MarketRef
  collateral: bigint
  borrowShares: bigint
  supplyShares: bigint
}

/** Result of an exact, point-in-time health computation. */
export interface HealthReport {
  position: Position
  /** Health factor, WAD-scaled. < 1e18 means liquidatable. */
  healthFactor: bigint
  /** Current LTV, WAD-scaled. */
  ltv: bigint
  /** Liquidation LTV threshold, WAD-scaled. */
  lltv: bigint
  /** Exact debt in loan-token assets after off-chain accrual up to `asOf`. */
  debtAssets: bigint
  /** Collateral value in loan token at the oracle price used. */
  collateralValue: bigint
  /** Oracle price at which the position becomes liquidatable (same scale as MarketState.oraclePrice). */
  liquidationPrice: bigint
  /** Relative distance to liquidation in basis points (0 = at the edge). */
  bufferBps: number
  /** Max additional loan assets borrowable while staying below LLTV. */
  maxBorrowable: bigint
  /** Max collateral withdrawable while staying below LLTV. */
  maxWithdrawable: bigint
  /** Unix seconds this report was computed for (accrual advanced to this time). */
  asOf: number
}

/** Oracle sanity check result. */
export interface OracleHealth {
  market: MarketRef
  price: bigint
  scale: bigint
  /** Deviation vs. the reference source in basis points (unsigned). */
  driftBps: number
  /** Reference source identifier (e.g. 'uniswap-v3-twap', 'manual'). */
  referenceSource: string
  /** True when the feed's heartbeat/last update exceeds the allowed staleness. */
  stale: boolean
  /** Unix seconds of the check. */
  asOf: number
}

/** Minimal calldata unit; composable into bundles and executor payloads. */
export interface Call {
  to: Address
  data: Hex
  value: bigint
}

/** Classification thresholds for watch/monitoring helpers, WAD-scaled HFs. */
export interface RiskThresholds {
  /** HF below this is 'danger' (default 1.05e18). */
  danger: bigint
  /** HF below this is 'warn' (default 1.2e18). */
  warn: bigint
}

export type RiskLevel = 'safe' | 'warn' | 'danger'
