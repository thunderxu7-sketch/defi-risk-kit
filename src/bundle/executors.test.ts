import { describe, expect, it } from 'vitest'

import type { Call } from '../core/types'
import { MULTICALL3_ADDRESS, customExecutor, multicall3, sequential } from './executors'

const CALLS: Call[] = [
  { to: '0x1111111111111111111111111111111111111111', value: 1n, data: '0x01' },
  { to: '0x2222222222222222222222222222222222222222', value: 2n, data: '0x02' },
  { to: '0x3333333333333333333333333333333333333333', value: 3n, data: '0x03' },
]

describe('executors', () => {
  it('sequential is the identity', () => {
    expect(sequential().wrap(CALLS)).toEqual(CALLS)
  })

  it('multicall3 wraps N calls into one with summed value', () => {
    const [wrapped, ...rest] = multicall3().wrap(CALLS)
    expect(rest).toHaveLength(0)
    expect(wrapped?.to).toBe(MULTICALL3_ADDRESS)
    expect(wrapped?.value).toBe(6n)
    expect(wrapped?.data.length).toBeGreaterThan(10)
  })

  it('custom executor delegates encoding and targets its contract', () => {
    const seen: Call[][] = []
    const executor = customExecutor({
      address: '0x9999999999999999999999999999999999999999',
      encode: (calls) => {
        seen.push(calls)
        return { data: '0xdead', value: 5n }
      },
    })
    const [wrapped] = executor.wrap(CALLS)
    expect(seen[0]).toEqual(CALLS)
    expect(wrapped).toEqual({
      to: '0x9999999999999999999999999999999999999999',
      value: 5n,
      data: '0xdead',
    })
  })
})
