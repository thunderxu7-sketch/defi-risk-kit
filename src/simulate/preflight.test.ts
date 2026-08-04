import { describe, expect, it } from 'vitest'

import { spendGap } from './preflight'

const REQ = {
  token: '0x1111111111111111111111111111111111111111',
  owner: '0x2222222222222222222222222222222222222222',
  spender: '0x3333333333333333333333333333333333333333',
  amount: 100n,
} as const

describe('spendGap', () => {
  it('ok when balance and allowance both cover the amount', () => {
    const g = spendGap(REQ, 100n, 200n)
    expect(g.ok).toBe(true)
    expect(g.missingBalance).toBe(0n)
    expect(g.missingAllowance).toBe(0n)
  })

  it('reports exact missing balance', () => {
    const g = spendGap(REQ, 40n, 1000n)
    expect(g.ok).toBe(false)
    expect(g.missingBalance).toBe(60n)
    expect(g.missingAllowance).toBe(0n)
  })

  it('reports exact missing allowance', () => {
    const g = spendGap(REQ, 1000n, 0n)
    expect(g.ok).toBe(false)
    expect(g.missingAllowance).toBe(100n)
  })

  it('can miss both at once', () => {
    const g = spendGap(REQ, 0n, 0n)
    expect(g.missingBalance).toBe(100n)
    expect(g.missingAllowance).toBe(100n)
  })
})
