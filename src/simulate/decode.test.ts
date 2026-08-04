import { encodeErrorResult, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import { decodeRevert, erc6093Abi } from './decode'

const errAbi = parseAbi(['error Error(string)', 'error Panic(uint256)'])

describe('decodeRevert', () => {
  it('decodes Error(string) and maps known Morpho require-strings', () => {
    const data = encodeErrorResult({
      abi: errAbi,
      errorName: 'Error',
      args: ['insufficient collateral'],
    })
    const decoded = decodeRevert(data)
    expect(decoded.kind).toBe('Error')
    expect(decoded.humanized).toContain('position would become unhealthy')
    expect(decoded.humanized).toContain('insufficient collateral')
  })

  it('passes through unknown require-strings verbatim', () => {
    const data = encodeErrorResult({ abi: errAbi, errorName: 'Error', args: ['whatever reason'] })
    expect(decodeRevert(data).humanized).toBe('reverted: "whatever reason"')
  })

  it('decodes Panic codes to human text', () => {
    const data = encodeErrorResult({ abi: errAbi, errorName: 'Panic', args: [0x11n] })
    const decoded = decodeRevert(data)
    expect(decoded.kind).toBe('Panic')
    expect(decoded.humanized).toBe('panic 0x11: arithmetic overflow or underflow')
  })

  it('decodes ERC-6093 custom errors with actionable text', () => {
    const data = encodeErrorResult({
      abi: erc6093Abi,
      errorName: 'ERC20InsufficientAllowance',
      args: ['0x1111111111111111111111111111111111111111', 5n, 10n],
    })
    const decoded = decodeRevert(data)
    expect(decoded.kind).toBe('Custom')
    expect(decoded.name).toBe('ERC20InsufficientAllowance')
    expect(decoded.humanized).toContain('approve first')
    expect(decoded.humanized).toContain('5')
    expect(decoded.humanized).toContain('10')
  })

  it('decodes user-supplied custom error ABIs', () => {
    const custom = parseAbi(['error PolicyViolation(uint256 code)'])
    const data = encodeErrorResult({ abi: custom, errorName: 'PolicyViolation', args: [7n] })
    const decoded = decodeRevert(data, [custom])
    expect(decoded.kind).toBe('Custom')
    expect(decoded.name).toBe('PolicyViolation')
    expect(decoded.humanized).toBe('PolicyViolation(7)')
  })

  it('degrades gracefully on empty and unknown data', () => {
    expect(decodeRevert('0x').kind).toBe('Unknown')
    expect(decodeRevert(undefined).humanized).toContain('without a reason')
    const unknown = decodeRevert('0xdeadbeef01')
    expect(unknown.kind).toBe('Unknown')
    expect(unknown.humanized).toContain('0xdeadbeef')
    expect(unknown.raw).toBe('0xdeadbeef01')
  })
})
