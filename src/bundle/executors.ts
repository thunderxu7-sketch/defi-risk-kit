import { encodeFunctionData, parseAbi } from 'viem'
import type { Address } from 'viem'

import type { Call } from '../core/types'
import type { Executor } from './types'

/** Canonical Multicall3, same address on virtually every EVM chain. */
export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const multicall3Abi = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'function aggregate3Value(Call3Value[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])

/** Identity strategy: keep the calls as-is (sequential EOA transactions). */
export function sequential(): Executor {
  return { id: 'sequential', wrap: (calls) => calls }
}

/**
 * Wrap all calls into one Multicall3 `aggregate3Value` transaction
 * (allowFailure=false → any leg reverting reverts the whole bundle).
 *
 * ⚠️ Inside the aggregate, `msg.sender` is the Multicall3 contract — token
 * approvals and protocol authorizations must target it. Good for demos and
 * for executor-owned funds; not for acting on a user's behalf unless the
 * protocol supports authorization of the executor.
 */
export function multicall3(address: Address = MULTICALL3_ADDRESS): Executor {
  return {
    id: `multicall3:${address}`,
    wrap: (calls: Call[]): Call[] => {
      const value = calls.reduce((sum, c) => sum + c.value, 0n)
      return [
        {
          to: address,
          value,
          data: encodeFunctionData({
            abi: multicall3Abi,
            functionName: 'aggregate3Value',
            args: [
              calls.map((c) => ({
                target: c.to,
                allowFailure: false,
                value: c.value,
                callData: c.data,
              })),
            ],
          }),
        },
      ]
    },
  }
}

/**
 * Custom executor seam: encode the ordered calls into whatever payload a
 * bespoke executor contract consumes (e.g. a policy-guarded deleverage
 * executor that sources repay funds via protocol callbacks). This kit only
 * defines the hook — the contract and its encoder live with the application.
 */
export function customExecutor(config: {
  address: Address
  /** Encode the ordered calls into the executor's calldata. */
  encode: (calls: Call[]) => { data: `0x${string}`; value?: bigint }
}): Executor {
  return {
    id: `custom:${config.address}`,
    wrap: (calls: Call[]): Call[] => {
      const encoded = config.encode(calls)
      return [{ to: config.address, value: encoded.value ?? 0n, data: encoded.data }]
    },
  }
}
