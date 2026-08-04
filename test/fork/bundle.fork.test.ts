import { encodeFunctionData, parseAbi, parseAbiItem } from 'viem'
import type { Address, Hex } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { morphoBlue } from '../../src/adapters/morpho-blue'
import type { MarketRef, Position } from '../../src/core/types'
import { multicall3 } from '../../src/bundle/executors'
import { assembleDeleverage, planDeleverage } from '../../src/bundle/plan'
import { uniswapV3Quoter } from '../../src/bundle/quoters'
import { simulateCalls } from '../../src/simulate/calls'
import { ANVIL_ACCOUNT, startFork } from './setup'
import type { ForkHarness } from './setup'

const FORK_RPC_URL = process.env.FORK_RPC_URL ?? 'https://mainnet.base.org'

const BASE = 8453
const WETH: Address = '0x4200000000000000000000000000000000000006'
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** WETH/USDC market on Base (verified via Morpho API, 2026-07-13). */
const WETH_USDC = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda' as Hex
const MORPHO: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'

const borrowEvent = parseAbiItem(
  'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
)

const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const adapter = morphoBlue()
const ref: MarketRef = { chainId: BASE, protocol: 'morpho-blue', marketId: WETH_USDC }

let fork: ForkHarness

beforeAll(async () => {
  fork = await startFork(FORK_RPC_URL, { port: 8548 })
}, 120_000)

afterAll(() => {
  fork?.stop()
})

/** Find a recent borrower on the market via Borrow logs (a few small chunks
 *  to stay inside public-RPC getLogs limits). */
async function findRecentBorrower(): Promise<Address | undefined> {
  const latest = await fork.publicClient.getBlockNumber()
  for (let i = 0; i < 4; i++) {
    const toBlock = latest - BigInt(i) * 2500n
    const fromBlock = toBlock - 2499n
    const logs = await fork.publicClient.getLogs({
      address: MORPHO,
      event: borrowEvent,
      args: { id: WETH_USDC },
      fromBlock,
      toBlock,
    })
    const last = logs.at(-1)
    if (last?.args.onBehalf) return last.args.onBehalf
  }
  return undefined
}

describe('uniswap v3 quoter on a real pool', () => {
  it('quotes WETH→USDC and builds an exactInputSingle call', async () => {
    const quoter = uniswapV3Quoter({ chainId: BASE, fee: 500 })
    const call = await quoter.buildSwap(fork.publicClient, {
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: 10n ** 18n, // 1 WETH
      minAmountOut: 100n * 10n ** 6n, // at least 100 USDC — trivially satisfied
      recipient: ANVIL_ACCOUNT.address,
    })
    expect(call.to.toLowerCase()).toBe('0x2626664c2603336E57B271c5C0b26F421741e481'.toLowerCase())
    expect(call.data.length).toBeGreaterThan(10)
  })

  it('rejects quotes below minAmountOut', async () => {
    const quoter = uniswapV3Quoter({ chainId: BASE, fee: 500 })
    await expect(
      quoter.buildSwap(fork.publicClient, {
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: 10n ** 15n, // 0.001 WETH
        minAmountOut: 1_000_000_000n * 10n ** 6n, // absurd 1B USDC
        recipient: ANVIL_ACCOUNT.address,
      }),
    ).rejects.toThrow(/below required minAmountOut/)
  })
})

describe('deleverage plan against a real borrower', () => {
  let borrower: Address | undefined
  let position: Position | undefined

  beforeAll(async () => {
    borrower = await findRecentBorrower()
    if (!borrower) return
    position = await adapter.getPosition(fork.publicClient, borrower, ref)
    if (position.borrowShares === 0n || position.collateral === 0n) {
      // fully repaid since the log — try none; the tests below will skip.
      position = undefined
    }
  }, 120_000)

  it('plan math holds on real state and predicts an HF improvement', async (ctx) => {
    if (!position) return ctx.skip()
    const state = await adapter.getMarket(fork.publicClient, ref)
    const plan = planDeleverage(adapter, position, state, { closeBps: 1000, slippageBps: 100 })

    expect(plan.repayAssets > 0n).toBe(true)
    expect(plan.withdrawCollateral > 0n).toBe(true)
    expect(plan.after.debtAssets).toBe(plan.before.debtAssets - plan.repayAssets)
    expect(plan.after.healthFactor > plan.before.healthFactor).toBe(true)
    expect(plan.swapRequest.minAmountOut).toBe(plan.repayAssets)
  })

  it('midStepHealthy matches what the real contract allows (withdraw leg eth_call)', async (ctx) => {
    if (!position) return ctx.skip()
    const state = await adapter.getMarket(fork.publicClient, ref)
    const plan = planDeleverage(adapter, position, state, { closeBps: 1000, slippageBps: 100 })
    const [withdrawLeg] = adapter.buildCalls.withdrawCollateral(
      position,
      state,
      plan.withdrawCollateral,
    )
    const [result] = await simulateCalls(fork.publicClient, [withdrawLeg!], {
      account: position.user,
    })
    expect(result?.success).toBe(plan.midStepHealthy)
    if (!result?.success) {
      expect(result?.revert?.humanized).toBeTruthy()
    }
  })

  it('assembles the full bundle; dependent legs decode readable failures under plain eth_call', async (ctx) => {
    if (!position) return ctx.skip()
    const state = await adapter.getMarket(fork.publicClient, ref)
    const plan = planDeleverage(adapter, position, state, { closeBps: 1000, slippageBps: 300 })
    let swapCall
    try {
      swapCall = await uniswapV3Quoter({ chainId: BASE, fee: 500 }).buildSwap(
        fork.publicClient,
        plan.swapRequest,
      )
    } catch {
      return ctx.skip() // pool thinner than the oracle assumption — not this test's subject
    }
    const calls = assembleDeleverage(adapter, state, plan, { swapCall })
    expect(calls).toHaveLength(5)

    const results = await simulateCalls(fork.publicClient, calls, { account: position.user })
    // Approvals always simulate fine; the swap leg must fail readable-ly:
    // the borrower's collateral sits inside Morpho, not in their wallet, and
    // plain eth_call runs each leg against the same base state (documented).
    expect(results[0]?.success).toBe(true)
    expect(results[1]?.success).toBe(true)
    const swapResult = results[3]
    expect(swapResult?.success).toBe(false)
    expect(swapResult?.revert?.humanized).toBeTruthy()
  })
})

describe('multicall3 executor against the real contract', () => {
  it('wrapped harmless approvals execute as one aggregate call', async () => {
    const calls = [
      {
        to: WETH,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [MORPHO, 0n] }),
      },
      {
        to: USDC,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [MORPHO, 0n] }),
      },
    ]
    const [wrapped] = multicall3().wrap(calls)
    const [result] = await simulateCalls(fork.publicClient, [wrapped!], {
      account: ANVIL_ACCOUNT.address,
    })
    expect(result?.success).toBe(true)
  })
})
