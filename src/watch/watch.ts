import type { Address, PublicClient } from 'viem'

import { WAD } from '../core/fixed-point'
import type { HealthReport, MarketRef, RiskLevel, RiskThresholds } from '../core/types'
import type { LendingAdapter } from '../adapters/types'
import { INFINITE_HEALTH, computeHealth } from '../health/compute'

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  danger: (105n * WAD) / 100n, // HF < 1.05
  warn: (12n * WAD) / 10n, // HF < 1.20
}

/** Classify a health report against thresholds. */
export function classify(
  report: Pick<HealthReport, 'healthFactor'>,
  thresholds: RiskThresholds = DEFAULT_THRESHOLDS,
): RiskLevel {
  if (report.healthFactor === INFINITE_HEALTH) return 'safe'
  if (report.healthFactor < thresholds.danger) return 'danger'
  if (report.healthFactor < thresholds.warn) return 'warn'
  return 'safe'
}

export interface WatchTarget {
  adapter: LendingAdapter
  user: Address
  ref: MarketRef
}

export interface WatchOptions {
  intervalMs?: number
  thresholds?: RiskThresholds
  /** Injectable clock (unix seconds) — used as the accrual timestamp. */
  now?: () => number
  onReport: (report: HealthReport, level: RiskLevel, target: WatchTarget) => void
  onError?: (error: unknown, target: WatchTarget) => void
}

/**
 * Thin polling primitive: every `intervalMs`, fetch state+position for each
 * target, compute an exact HealthReport and emit it with its risk level.
 *
 * Deliberately does nothing else — no notifications, no persistence, no
 * decisions. Returns a stop function; the first sweep runs immediately.
 */
export function watchHealth(client: PublicClient, targets: WatchTarget[], options: WatchOptions) {
  const intervalMs = options.intervalMs ?? 15_000
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  let stopped = false

  async function sweep(): Promise<void> {
    for (const target of targets) {
      if (stopped) return
      try {
        const [state, position] = await Promise.all([
          target.adapter.getMarket(client, target.ref),
          target.adapter.getPosition(client, target.user, target.ref),
        ])
        const report = computeHealth(target.adapter, position, state, { at: now() })
        options.onReport(report, classify(report, options.thresholds), target)
      } catch (error) {
        options.onError?.(error, target)
      }
    }
  }

  void sweep()
  const timer = setInterval(() => void sweep(), intervalMs)

  return function stop(): void {
    stopped = true
    clearInterval(timer)
  }
}
