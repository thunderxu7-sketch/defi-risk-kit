import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { createPublicClient, createTestClient, createWalletClient, http } from 'viem'
import type { PublicClient, TestClient, WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** anvil's default funded account #0. */
export const ANVIL_ACCOUNT = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

export interface ForkHarness {
  publicClient: PublicClient
  testClient: TestClient
  walletClient: WalletClient
  rpcUrl: string
  stop(): void
  /** Advance chain time by `seconds` and mine one block. */
  warp(seconds: number): Promise<void>
}

export interface StartForkOptions {
  /** Distinct ports let multiple fork test files run in parallel workers. */
  port?: number
  forkBlock?: bigint
}

/**
 * Spawn an anvil fork of `forkUrl` and return viem clients bound to it.
 * Requires foundry's `anvil` on PATH. Callers own teardown via `stop()`.
 */
export async function startFork(
  forkUrl: string,
  options: StartForkOptions = {},
): Promise<ForkHarness> {
  const port = options.port ?? 8547
  const args = ['--fork-url', forkUrl, '--port', String(port), '--silent']
  if (options.forkBlock) args.push('--fork-block-number', options.forkBlock.toString())
  const proc: ChildProcess = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  const rpcUrl = `http://127.0.0.1:${port}`
  const transport = http(rpcUrl, { timeout: 60_000 })
  const publicClient = createPublicClient({ transport })
  const testClient = createTestClient({ mode: 'anvil', transport })
  const walletClient = createWalletClient({ account: ANVIL_ACCOUNT, transport })

  // Wait until the fork answers.
  const deadline = Date.now() + 60_000
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`anvil exited early (code ${proc.exitCode}): ${stderr.slice(0, 500)}`)
    }
    try {
      await publicClient.getBlockNumber()
      break
    } catch {
      if (Date.now() > deadline) {
        proc.kill()
        throw new Error(`anvil did not become ready in 60s: ${stderr.slice(0, 500)}`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  return {
    publicClient,
    testClient,
    walletClient,
    rpcUrl,
    stop: () => {
      proc.kill()
    },
    warp: async (seconds: number) => {
      await testClient.increaseTime({ seconds })
      await testClient.mine({ blocks: 1 })
    },
  }
}
