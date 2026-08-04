import type { Abi, Address, Hex, PublicClient, StateOverride } from 'viem'

import type { Call } from '../core/types'
import { decodeRevert } from './decode'
import type { DecodedRevert } from './decode'

export interface SimulateOptions {
  /** Caller for all calls. */
  account: Address
  /** viem state overrides applied to every call (balances, storage, code). */
  stateOverride?: StateOverride
  /** Extra ABIs for custom-error decoding. */
  abis?: Abi[]
}

export interface SimulatedCall {
  call: Call
  success: boolean
  returnData?: Hex
  revert?: DecodedRevert
}

/**
 * Dry-run calls via `eth_call` and decode failures into readable reverts.
 *
 * ⚠️ Each call executes against the SAME base state, independently — state
 * changes do NOT carry over between calls (plain eth_call semantics). To
 * preview a stateful bundle end-to-end, run it against a fork (see the
 * fork test harness) or an executor-level simulation.
 */
export async function simulateCalls(
  client: PublicClient,
  calls: Call[],
  options: SimulateOptions,
): Promise<SimulatedCall[]> {
  const results: SimulatedCall[] = []
  for (const call of calls) {
    try {
      const { data } = await client.call({
        account: options.account,
        to: call.to,
        data: call.data,
        value: call.value,
        ...(options.stateOverride ? { stateOverride: options.stateOverride } : {}),
      })
      results.push({ call, success: true, ...(data ? { returnData: data } : {}) })
    } catch (error) {
      results.push({
        call,
        success: false,
        revert: decodeRevert(extractRevertData(error), options.abis ?? []),
      })
    }
  }
  return results
}

/** Walk a viem error chain and pull out raw revert bytes, if any. */
export function extractRevertData(error: unknown): Hex | undefined {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const node = current as { data?: unknown; cause?: unknown }
    const d = node.data
    if (typeof d === 'string' && d.startsWith('0x')) return d as Hex
    if (
      d &&
      typeof d === 'object' &&
      typeof (d as { data?: unknown }).data === 'string' &&
      ((d as { data: string }).data as string).startsWith('0x')
    ) {
      return (d as { data: Hex }).data
    }
    current = node.cause
  }
  return undefined
}
