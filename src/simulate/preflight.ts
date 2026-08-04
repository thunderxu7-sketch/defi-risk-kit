import { parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'

const erc20ReadAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

/** One ERC-20 spend a bundle intends to make on behalf of `owner`. */
export interface SpendRequirement {
  token: Address
  owner: Address
  spender: Address
  amount: bigint
}

export interface SpendGap extends SpendRequirement {
  balance: bigint
  allowance: bigint
  /** How much balance is missing (0n when sufficient). */
  missingBalance: bigint
  /** How much allowance is missing (0n when sufficient). */
  missingAllowance: bigint
  /** True when both balance and allowance cover the amount. */
  ok: boolean
}

/** Pure gap math — separated for golden-vector testing. */
export function spendGap(req: SpendRequirement, balance: bigint, allowance: bigint): SpendGap {
  const missingBalance = balance >= req.amount ? 0n : req.amount - balance
  const missingAllowance = allowance >= req.amount ? 0n : req.amount - allowance
  return {
    ...req,
    balance,
    allowance,
    missingBalance,
    missingAllowance,
    ok: missingBalance === 0n && missingAllowance === 0n,
  }
}

/**
 * Check balances/allowances for the ERC-20 spends a bundle will need.
 * Returns one gap report per requirement; callers turn missing allowances
 * into approve calls (e.g. adapter.buildCalls.approveIfNeeded).
 */
export async function preflightSpends(
  client: PublicClient,
  requirements: SpendRequirement[],
): Promise<SpendGap[]> {
  return Promise.all(
    requirements.map(async (req) => {
      const [balance, allowance] = await Promise.all([
        client.readContract({
          address: req.token,
          abi: erc20ReadAbi,
          functionName: 'balanceOf',
          args: [req.owner],
        }),
        client.readContract({
          address: req.token,
          abi: erc20ReadAbi,
          functionName: 'allowance',
          args: [req.owner, req.spender],
        }),
      ])
      return spendGap(req, balance, allowance)
    }),
  )
}
