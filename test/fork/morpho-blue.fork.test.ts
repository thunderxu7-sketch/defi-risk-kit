import { encodeFunctionData, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_DEPLOYMENTS, morphoBlue } from '../../src/adapters/morpho-blue'
import { WAD } from '../../src/core/fixed-point'
import type { MarketRef } from '../../src/core/types'
import { computeHealth } from '../../src/health/compute'
import { checkOracle } from '../../src/oracle/check'
import { manualReference } from '../../src/oracle/sources'
import { simulateCalls } from '../../src/simulate/calls'
import { preflightSpends } from '../../src/simulate/preflight'
import { ANVIL_ACCOUNT, startFork } from './setup'
import type { ForkHarness } from './setup'

const FORK_RPC_URL = process.env.FORK_RPC_URL ?? 'https://mainnet.base.org'

// Real Base markets, verified against the Morpho API at authoring time (2026-07-13).
const CBBTC_USDC = '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' as Hex
const WETH_USDC = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda' as Hex
const MARKET_ID = (process.env.FORK_MARKET_ID as Hex | undefined) ?? CBBTC_USDC

/** Base USDC (also the loan token of both markets above). */
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const BASE = 8453
const MORPHO = DEFAULT_DEPLOYMENTS[BASE]!.morpho

const accrueAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function accrueInterest(MarketParams marketParams)',
])

const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

const adapter = morphoBlue()
const ref: MarketRef = { chainId: BASE, protocol: 'morpho-blue', marketId: MARKET_ID }
const ref2: MarketRef = { chainId: BASE, protocol: 'morpho-blue', marketId: WETH_USDC }

let fork: ForkHarness

beforeAll(async () => {
  fork = await startFork(FORK_RPC_URL)
}, 120_000)

afterAll(() => {
  fork?.stop()
})

describe('morpho-blue adapter against a real Base fork', () => {
  it('getMarket returns a coherent, populated state', async () => {
    const state = await adapter.getMarket(fork.publicClient, ref)
    expect(state.totalSupplyAssets > 0n).toBe(true)
    expect(state.totalBorrowAssets > 0n).toBe(true)
    expect(state.lltv > 0n && state.lltv <= WAD).toBe(true)
    expect(state.oraclePrice > 0n).toBe(true)
    expect(state.borrowRatePerSecond > 0n).toBe(true)
    expect(state.lastAccrual).toBeGreaterThan(1_600_000_000)
    expect(state.loanDecimals).toBe(6) // USDC
    expect(state.native).toBeTruthy()
  })

  it('getPosition returns zeros for a fresh address', async () => {
    const pos = await adapter.getPosition(fork.publicClient, ANVIL_ACCOUNT.address, ref)
    expect(pos.collateral).toBe(0n)
    expect(pos.borrowShares).toBe(0n)
    expect(pos.supplyShares).toBe(0n)
  })

  it('off-chain accrue matches on-chain accrueInterest within 1 bp over a 10-min warp', async () => {
    const before = await adapter.getMarket(fork.publicClient, ref)
    await fork.warp(600)

    const params = before.native as {
      loanToken: Address
      collateralToken: Address
      oracle: Address
      irm: Address
      lltv: bigint
    }
    const hash = await fork.walletClient.sendTransaction({
      account: ANVIL_ACCOUNT,
      chain: null,
      to: MORPHO,
      data: encodeFunctionData({ abi: accrueAbi, functionName: 'accrueInterest', args: [params] }),
    })
    const receipt = await fork.publicClient.waitForTransactionReceipt({ hash })
    const block = await fork.publicClient.getBlock({ blockNumber: receipt.blockNumber })

    const onChain = await adapter.getMarket(fork.publicClient, ref)
    const ours = adapter.accrue(before, Number(block.timestamp))

    const chainInterest = onChain.totalBorrowAssets - before.totalBorrowAssets
    const ourInterest = ours.totalBorrowAssets - before.totalBorrowAssets
    expect(chainInterest > 0n).toBe(true)

    const diff =
      chainInterest > ourInterest ? chainInterest - ourInterest : ourInterest - chainInterest
    const tolerance = chainInterest / 10_000n + 2n // ≤1bp + rounding headroom
    expect(diff <= tolerance).toBe(true)
    expect(onChain.lastAccrual).toBe(Number(block.timestamp))
  }, 120_000)

  it('computeHealth is internally consistent on real market state', async () => {
    const state = await adapter.getMarket(fork.publicClient, ref)
    const position = {
      user: ANVIL_ACCOUNT.address,
      market: ref,
      collateral: 10n ** BigInt(state.collateralDecimals), // 1 collateral token
      borrowShares: state.totalBorrowShares / 1_000_000n,
      supplyShares: 0n,
    }
    const report = computeHealth(adapter, position, state, { at: state.lastAccrual + 3600 })
    expect(report.debtAssets > 0n).toBe(true)
    expect(report.collateralValue > 0n).toBe(true)
    expect(report.healthFactor > 0n).toBe(true)
    // HF ≈ capacity / debt by definition
    const capacity = (report.collateralValue * state.lltv) / WAD
    const recomputed = (capacity * WAD) / report.debtAssets
    expect(report.healthFactor).toBe(recomputed)
  })
})

describe('oracle checks on two real markets', () => {
  it('zero drift against itself; ~2% manual reference registers ~200 bps', async () => {
    for (const marketRef of [ref, ref2]) {
      const state = await adapter.getMarket(fork.publicClient, marketRef)
      const self = await checkOracle(fork.publicClient, state, {
        reference: manualReference(state.oraclePrice),
      })
      expect(self.driftBps).toBe(0)
      expect(self.stale).toBe(false)

      const skewed = await checkOracle(fork.publicClient, state, {
        reference: manualReference((state.oraclePrice * 98n) / 100n),
        maxStalenessSeconds: 3600,
        now: Math.floor(Date.now() / 1000),
      })
      expect(skewed.driftBps).toBeGreaterThanOrEqual(200)
      expect(skewed.driftBps).toBeLessThanOrEqual(209)
    }
  }, 120_000)
})

describe('simulate + preflight against real contracts', () => {
  it('decodes a real ERC20 transfer revert into readable text', async () => {
    const results = await simulateCalls(
      fork.publicClient,
      [
        {
          to: USDC,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [MORPHO, 1_000_000_000_000n], // 1M USDC the anvil account does not have
          }),
        },
      ],
      { account: ANVIL_ACCOUNT.address },
    )
    expect(results[0]?.success).toBe(false)
    expect(results[0]?.revert?.humanized.toLowerCase()).toContain('transfer amount exceeds balance')
  })

  it('reports exact balance/allowance gaps for a planned spend', async () => {
    const [gap] = await preflightSpends(fork.publicClient, [
      { token: USDC, owner: ANVIL_ACCOUNT.address, spender: MORPHO, amount: 100n },
    ])
    expect(gap?.ok).toBe(false)
    expect(gap?.missingBalance).toBe(100n)
    expect(gap?.missingAllowance).toBe(100n)
  })
})
