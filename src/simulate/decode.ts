import { decodeErrorResult, parseAbi } from 'viem'
import type { Abi, Hex } from 'viem'

export interface DecodedRevert {
  kind: 'Error' | 'Panic' | 'Custom' | 'Unknown'
  /** Error name ('Error', 'Panic', custom error name, or 'UnknownRevert'). */
  name: string
  args?: readonly unknown[]
  /** Human-readable one-liner suitable for logs/UIs/LLM prompts. */
  humanized: string
  raw: Hex
}

const solidityErrorAbi = parseAbi(['error Error(string message)', 'error Panic(uint256 code)'])

/** OpenZeppelin v5 / ERC-6093 standard token errors. */
export const erc6093Abi = parseAbi([
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidSpender(address spender)',
  'error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)',
  'error ERC4626ExceededMaxMint(address receiver, uint256 shares, uint256 max)',
  'error ERC4626ExceededMaxWithdraw(address owner, uint256 assets, uint256 max)',
  'error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max)',
])

/** Panic(uint256) codes → meaning (Solidity docs). */
const PANIC_CODES: Record<number, string> = {
  0x00: 'generic compiler panic',
  0x01: 'assertion failed (assert)',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum conversion',
  0x22: 'corrupted storage byte array',
  0x31: 'pop on empty array',
  0x32: 'array index out of bounds',
  0x41: 'out-of-memory allocation',
  0x51: 'call to a zero-initialized internal function',
}

/** Morpho Blue reverts with require-strings; map the known ones to clearer text. */
const MORPHO_MESSAGES: Record<string, string> = {
  'insufficient collateral':
    'position would become unhealthy — not enough collateral for this action',
  'insufficient liquidity': 'market does not have enough liquidity for this borrow/withdraw',
  'market not created': 'this market does not exist on this deployment',
  'position is healthy': 'cannot liquidate — the position is still healthy',
  unauthorized: 'caller is not authorized to act on this position',
  'zero assets': 'amount must be non-zero',
  'zero address': 'a required address argument is the zero address',
  'inconsistent input': 'exactly one of assets/shares must be provided',
  'max uint128 exceeded': 'amount exceeds the uint128 accounting limit',
  'irm not enabled': 'interest rate model is not whitelisted on this deployment',
  'lltv not enabled': 'LLTV value is not whitelisted on this deployment',
  'market already created': 'a market with these params already exists',
}

function humanizeCustom(name: string, args: readonly unknown[]): string {
  switch (name) {
    case 'ERC20InsufficientBalance':
      return `token balance too low: ${String(args[0])} holds ${String(args[1])} but needs ${String(args[2])}`
    case 'ERC20InsufficientAllowance':
      return `allowance too low: spender ${String(args[0])} is allowed ${String(args[1])} but needs ${String(args[2])} — approve first`
    case 'ERC4626ExceededMaxDeposit':
    case 'ERC4626ExceededMaxMint':
      return `${name.replace('ERC4626Exceeded', 'vault cap exceeded: ')}${String(args[1])} requested, max ${String(args[2])}`
    case 'ERC4626ExceededMaxWithdraw':
    case 'ERC4626ExceededMaxRedeem':
      return `vault limit exceeded: ${String(args[1])} requested, max currently ${String(args[2])}`
    default:
      return `${name}(${args.map(String).join(', ')})`
  }
}

/**
 * Decode raw revert data into a structured, human-readable form.
 *
 * Handles Error(string) (incl. Morpho Blue's require-strings), Panic(uint256),
 * and custom errors resolvable from `abis` (ERC-6093 built in). Unknown
 * selectors degrade gracefully with the raw data preserved.
 */
export function decodeRevert(data: Hex | undefined, abis: Abi[] = []): DecodedRevert {
  if (!data || data === '0x') {
    return {
      kind: 'Unknown',
      name: 'UnknownRevert',
      humanized: 'reverted without a reason (out of gas, invalid opcode, or empty revert)',
      raw: data ?? '0x',
    }
  }

  // Error(string) / Panic(uint256)
  try {
    const decoded = decodeErrorResult({ abi: solidityErrorAbi, data })
    if (decoded.errorName === 'Error') {
      const message = decoded.args[0] as string
      const known = MORPHO_MESSAGES[message]
      return {
        kind: 'Error',
        name: 'Error',
        args: decoded.args,
        humanized: known ? `${known} (revert: "${message}")` : `reverted: "${message}"`,
        raw: data,
      }
    }
    if (decoded.errorName === 'Panic') {
      const code = Number(decoded.args[0] as bigint)
      return {
        kind: 'Panic',
        name: 'Panic',
        args: decoded.args,
        humanized: `panic 0x${code.toString(16)}: ${PANIC_CODES[code] ?? 'unknown panic code'}`,
        raw: data,
      }
    }
  } catch {
    // fall through to custom error registry
  }

  for (const abi of [erc6093Abi as Abi, ...abis]) {
    try {
      const decoded = decodeErrorResult({ abi, data })
      const args = decoded.args ?? []
      return {
        kind: 'Custom',
        name: decoded.errorName,
        args,
        humanized: humanizeCustom(decoded.errorName, args),
        raw: data,
      }
    } catch {
      // try next abi
    }
  }

  return {
    kind: 'Unknown',
    name: 'UnknownRevert',
    humanized: `reverted with unrecognized data (selector ${data.slice(0, 10)}) — pass the contract ABI to decode it`,
    raw: data,
  }
}
