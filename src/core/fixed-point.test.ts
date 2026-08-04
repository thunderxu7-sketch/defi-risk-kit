import { describe, expect, it } from 'vitest'

import {
  WAD,
  bpsToWad,
  mulDivDown,
  mulDivUp,
  wDivUp,
  wMulDown,
  wTaylorCompounded,
} from './fixed-point'

describe('mulDiv', () => {
  it('rounds down vs up around a non-exact quotient', () => {
    expect(mulDivDown(10n, 10n, 3n)).toBe(33n)
    expect(mulDivUp(10n, 10n, 3n)).toBe(34n)
  })

  it('agrees on exact quotients', () => {
    expect(mulDivDown(6n, 4n, 3n)).toBe(8n)
    expect(mulDivUp(6n, 4n, 3n)).toBe(8n)
  })

  it('throws on division by zero', () => {
    expect(() => mulDivDown(1n, 1n, 0n)).toThrow(RangeError)
    expect(() => mulDivUp(1n, 1n, 0n)).toThrow(RangeError)
  })
})

describe('wad helpers', () => {
  it('wMulDown is identity against WAD', () => {
    expect(wMulDown(123n * WAD, WAD)).toBe(123n * WAD)
  })

  it('wDivUp rounds up at sub-wei boundaries', () => {
    expect(wDivUp(1n, 3n * WAD)).toBe(1n)
  })

  it('bpsToWad maps 10000 bps to 1 WAD', () => {
    expect(bpsToWad(10_000)).toBe(WAD)
    expect(bpsToWad(50)).toBe(WAD / 200n)
    expect(() => bpsToWad(-1)).toThrow(RangeError)
  })
})

describe('wTaylorCompounded', () => {
  it('is zero for zero rate or zero time', () => {
    expect(wTaylorCompounded(0n, 1000n)).toBe(0n)
    expect(wTaylorCompounded(1000n, 0n)).toBe(0n)
  })

  it('grows monotonically with elapsed time', () => {
    const rate = WAD / 1_000_000_000n // small per-second rate
    const a = wTaylorCompounded(rate, 60n)
    const b = wTaylorCompounded(rate, 3600n)
    expect(b > a).toBe(true)
  })

  it('first-order dominates for tiny exponents', () => {
    const rate = 1_000n
    const t = 10n
    const linear = rate * t
    const compounded = wTaylorCompounded(rate, t)
    expect(compounded >= linear).toBe(true)
    expect(compounded - linear < linear).toBe(true)
  })
})
