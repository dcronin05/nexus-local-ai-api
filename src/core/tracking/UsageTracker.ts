/**
 * @file UsageTracker.ts
 * @description Tracks API usage metrics across all providers and models,
 * maintaining in-memory counters with file-based persistence via append-only
 * JSONL logging. Provides aggregated snapshots for the dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  UsageRecord,
  UsageSnapshot,
  TaskCategory,
  CreditBalance,
} from '../providers/types';

/**
 * Tracks, aggregates, and persists API usage data across all providers.
 *
 * @remarks
 * The tracker maintains an in-memory ring buffer of the most recent records
 * (capped at 1 000) plus running counter maps for fast snapshot generation.
 * Each record is also appended to a JSONL file for durable persistence and
 * offline analysis.
 *
 * @example
 * ```typescript
 * const tracker = new UsageTracker('./data');
 *
 * tracker.record({
 *   id: 'req-001',
 *   timestamp: new Date(),
 *   provider: 'openrouter',
 *   model: 'anthropic/claude-sonnet-4',
 *   taskCategory: 'coding',
 *   usage: { promptTokens: 150, completionTokens: 300, totalTokens: 450 },
 *   latencyMs: 1200,
 *   cost: { promptCost: 0.0005, completionCost: 0.0015, totalCost: 0.002 },
 *   routingDecision: 'auto:coding→anthropic/claude-sonnet-4@openrouter',
 * });
 *
 * const snapshot = tracker.getSnapshot();
 * console.log(snapshot.totalRequests); // 1
 * ```
 */
export class UsageTracker {
  /** Maximum number of records retained in the in-memory ring buffer. */
  private static readonly _MAX_IN_MEMORY_RECORDS: number = 1_000;

  /** Number of recent records included in snapshots. */
  private static readonly _SNAPSHOT_RECENT_COUNT: number = 50;

  /** In-memory ring buffer of recent usage records. */
  private readonly _records: UsageRecord[];

  /** Running total of all requests processed. */
  private _totalRequests: number;

  /** Running total of all tokens consumed. */
  private _totalTokens: number;

  /** Running total of all costs incurred (USD). */
  private _totalCost: number;

  /** Request counts keyed by provider name. */
  private readonly _requestsByProvider: Map<string, number>;

  /** Request counts keyed by model ID. */
  private readonly _requestsByModel: Map<string, number>;

  /** Request counts keyed by task category. */
  private readonly _requestsByTask: Map<TaskCategory, number>;

  /** Cumulative latency in milliseconds keyed by provider, for average calculation. */
  private readonly _latencySumByProvider: Map<string, number>;

  /** Number of latency samples keyed by provider, for average calculation. */
  private readonly _latencyCountByProvider: Map<string, number>;

  /** Most recently known credit balance, if available. */
  private _creditBalance: CreditBalance | null;

  /** Absolute path to the JSONL log file. */
  private readonly _logFilePath: string;

  /**
   * Creates a new UsageTracker.
   *
   * @param logDir - Directory for the JSONL log file. Defaults to
   *   `<cwd>/data`. The directory is created recursively if it does not exist.
   * @throws {Error} If the log directory cannot be created.
   */
  public constructor(logDir: string = path.join(process.cwd(), 'data')) {
    if (!logDir || logDir.trim().length === 0) {
      throw new Error('UsageTracker requires a non-empty logDir path.');
    }

    // Ensure the log directory exists
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to create log directory "${logDir}": ` +
          (err instanceof Error ? err.message : String(err))
      );
    }

    this._logFilePath = path.join(logDir, 'usage_log.jsonl');
    this._records = [];
    this._totalRequests = 0;
    this._totalTokens = 0;
    this._totalCost = 0;
    this._requestsByProvider = new Map<string, number>();
    this._requestsByModel = new Map<string, number>();
    this._requestsByTask = new Map<TaskCategory, number>();
    this._latencySumByProvider = new Map<string, number>();
    this._latencyCountByProvider = new Map<string, number>();
    this._creditBalance = null;
  }

  /**
   * Records a single usage event, updating all in-memory counters and
   * appending to the persistent log file.
   *
   * @param record - The usage record to track. Must include at minimum
   *   `provider`, `model`, and `taskCategory`.
   */
  public record(record: UsageRecord): void {
    // Add to ring buffer, trimming if necessary
    this._records.push(record);
    if (this._records.length > UsageTracker._MAX_IN_MEMORY_RECORDS) {
      this._records.splice(0, this._records.length - UsageTracker._MAX_IN_MEMORY_RECORDS);
    }

    // Update running totals
    this._totalRequests += 1;

    if (record.usage) {
      this._totalTokens += record.usage.totalTokens ?? 0;
    }

    if (record.cost) {
      this._totalCost += record.cost.totalCost ?? 0;
    }

    // Update per-dimension counters
    this._incrementMap(this._requestsByProvider, record.provider);
    this._incrementMap(this._requestsByModel, record.model);
    this._incrementMap(this._requestsByTask, record.taskCategory);

    // Update latency tracking
    if (typeof record.latencyMs === 'number' && record.latencyMs >= 0) {
      const currentSum = this._latencySumByProvider.get(record.provider) ?? 0;
      this._latencySumByProvider.set(record.provider, currentSum + record.latencyMs);

      const currentCount = this._latencyCountByProvider.get(record.provider) ?? 0;
      this._latencyCountByProvider.set(record.provider, currentCount + 1);
    }

    // Fire-and-forget log append
    this._appendToLog(record);
  }

  /**
   * Updates the cached credit balance.
   *
   * @param balance - The latest credit balance from the provider.
   */
  public updateCreditBalance(balance: CreditBalance): void {
    this._creditBalance = balance;
  }

  /**
   * Builds and returns a frozen snapshot of the current usage statistics.
   *
   * @returns A read-only {@link UsageSnapshot} containing all aggregated
   *   metrics, recent requests, and credit balance information.
   */
  public getSnapshot(): Readonly<UsageSnapshot> {
    // Compute average latency per provider
    const avgLatencyByProvider: Record<string, number> = {};
    for (const [provider, sum] of this._latencySumByProvider) {
      const count = this._latencyCountByProvider.get(provider) ?? 1;
      avgLatencyByProvider[provider] = Math.round(sum / count);
    }

    // Extract the most recent records for the snapshot
    const recentStart = Math.max(0, this._records.length - UsageTracker._SNAPSHOT_RECENT_COUNT);
    const recentRequests = this._records.slice(recentStart);

    const snapshot: UsageSnapshot = {
      totalRequests: this._totalRequests,
      totalTokens: this._totalTokens,
      totalCost: this._totalCost,
      requestsByProvider: Object.fromEntries(this._requestsByProvider),
      requestsByModel: Object.fromEntries(this._requestsByModel),
      requestsByTask: Object.fromEntries(this._requestsByTask),
      avgLatencyByProvider,
      recentRequests,
      creditBalance: this._creditBalance ?? undefined,
    };

    return Object.freeze(snapshot);
  }

  /**
   * Appends a usage record to the JSONL log file.
   *
   * @remarks
   * This is a fire-and-forget operation. Errors are logged to the console
   * but do not propagate — usage tracking should never disrupt the
   * request pipeline.
   *
   * @param record - The record to serialize and append.
   */
  private _appendToLog(record: UsageRecord): void {
    const line = JSON.stringify(record) + '\n';

    fs.promises.appendFile(this._logFilePath, line, 'utf-8').catch((err) => {
      console.error(
        '[UsageTracker] Failed to append to log file:',
        err instanceof Error ? err.message : err
      );
    });
  }

  /**
   * Increments a counter in the given map by 1.
   *
   * @param map - The counter map to update.
   * @param key - The key whose count should be incremented.
   */
  private _incrementMap<K>(map: Map<K, number>, key: K): void {
    const current = map.get(key) ?? 0;
    map.set(key, current + 1);
  }
}
