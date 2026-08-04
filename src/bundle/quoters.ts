import { encodeFunctionData, parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'

import type { Call } from '../core/types'
import type { SwapQuoter, SwapRequest } from './types'

/** Pre-computed swap injection — for aggregator calldata or tests.
 *  The builder validates the request it was armed for. */
export function staticQuote(call: Call, forRequest?: Partial<SwapRequest>): SwapQuoter {
  return {
    id: 'static',
    buildSwap: (_client, request) => {
      if (forRequest) {
        for (const key of ['tokenIn', 'tokenOut', 'amountIn', 'minAmountOut'] as const) {
          const expected = forRequest[key]
          if (expected !== undefined && expected !== request[key]) {
            throw new Error(`staticQuote: request.${key} does not match the armed quote`)
          }
        }
      }
      return Promise.resolve(call)
    },
  }
}

const quoterV2Abi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

const swapRouter02Abi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
])

export interface UniswapV3Deployment {
  quoter: Address
  router: Address
}

/** Uniswap V3 QuoterV2 + SwapRouter02 (canonical deployments). */
export const UNISWAP_V3_DEPLOYMENTS: Record<number, UniswapV3Deployment> = {
  1: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  },
  8453: {
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
  },
}

export interface UniswapV3QuoterConfig {
  chainId: number
  /** Pool fee tier in hundredths of a bip (500 = 0.05%). */
  fee: number
  deployment?: UniswapV3Deployment
}

/**
 * Single-hop Uniswap V3 quoter: verifies the pool can fill the request
 * (QuoterV2 via eth_call) and builds an `exactInputSingle` router call with
 * `amountOutMinimum = request.minAmountOut`.
 */
export function uniswapV3Quoter(config: UniswapV3QuoterConfig): SwapQuoter {
  const deployment = config.deployment ?? UNISWAP_V3_DEPLOYMENTS[config.chainId]
  if (!deployment) {
    throw new Error(`uniswapV3Quoter: no canonical deployment for chainId ${config.chainId}`)
  }
  return {
    id: `uniswap-v3:${config.chainId}:${config.fee}`,
    async buildSwap(client: PublicClient, request: SwapRequest): Promise<Call> {
      const { result } = await client.simulateContract({
        address: deployment.quoter,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            amountIn: request.amountIn,
            fee: config.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })
      const [amountOut] = result
      if (amountOut < request.minAmountOut) {
        throw new Error(
          `uniswapV3Quoter: pool quote ${amountOut} below required minAmountOut ${request.minAmountOut} — ` +
            'raise slippageBps or use a deeper route',
        )
      }
      return {
        to: deployment.router,
        value: 0n,
        data: encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: request.tokenIn,
              tokenOut: request.tokenOut,
              fee: config.fee,
              recipient: request.recipient,
              amountIn: request.amountIn,
              amountOutMinimum: request.minAmountOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
      }
    },
  }
}
