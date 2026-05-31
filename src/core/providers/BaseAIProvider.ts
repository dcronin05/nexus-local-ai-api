/**
 * @fileoverview Abstract base class for all AI providers in the Nexus AI Gateway.
 *
 * {@link BaseAIProvider} defines the contract that every concrete provider
 * (OpenRouter, Ollama, etc.) must implement. It manages common availability
 * state and exposes a uniform health-status snapshot used by the routing
 * engine and dashboard.
 *
 * Subclasses update internal state through protected setters and must
 * implement the abstract lifecycle, health-check, and core-operation methods.
 */

import {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  ModelInfo,
  ProviderHealthStatus,
} from './types';

/**
 * Base abstract class that all AI providers must extend.
 *
 * Defines the contract for initialisation, disposal, health checking,
 * model listing, and chat completion. Tracks availability state so the
 * routing engine can make informed decisions.
 *
 * @example
 * ```typescript
 * class MyProvider extends BaseAIProvider {
 *   public get providerName(): string { return 'my-provider'; }
 *   // … implement abstract members …
 * }
 * ```
 */
export abstract class BaseAIProvider {
  // ─── Internal state ─────────────────────────────────────────────────

  /** Whether this provider is currently reachable and operational. */
  private _isAvailable: boolean = false;

  /** Timestamp of the most recent health check (epoch-zero until first check). */
  private _lastCheckTime: Date = new Date(0);

  /** Human-readable description of the last error, if any. */
  private _lastError?: string;

  // ─── Abstract identity ──────────────────────────────────────────────

  /**
   * Unique, human-readable name for this provider (e.g. 'openrouter', 'ollama').
   *
   * Used as a key in routing decisions, usage records, and health dashboards.
   */
  public abstract get providerName(): string;

  // ─── Availability accessors ─────────────────────────────────────────

  /**
   * Whether this provider is currently available to serve requests.
   *
   * Updated by concrete subclasses via {@link setAvailable}.
   */
  public get isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Update the availability flag.
   *
   * @param available - `true` if the provider is reachable, `false` otherwise.
   */
  protected setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  /**
   * Timestamp of the most recent health check.
   *
   * Returns epoch-zero (`new Date(0)`) if no check has been performed yet.
   */
  public get lastCheckTime(): Date {
    return this._lastCheckTime;
  }

  /**
   * Record the time of the latest health check.
   *
   * @param time - The {@link Date} when the check completed.
   */
  protected setLastCheckTime(time: Date): void {
    this._lastCheckTime = time;
  }

  /**
   * Human-readable description of the last error encountered, or
   * `undefined` if the most recent operation succeeded.
   */
  public get lastError(): string | undefined {
    return this._lastError;
  }

  /**
   * Store or clear the last error description.
   *
   * @param error - An error message string, or `undefined` to clear.
   */
  protected setLastError(error: string | undefined): void {
    this._lastError = error;
  }

  // ─── Lifecycle (abstract) ───────────────────────────────────────────

  /**
   * Initialise the provider.
   *
   * Implementations should perform any one-time setup (e.g. validating
   * API keys, warming caches) and call {@link checkHealth} to establish
   * initial availability.
   */
  public abstract initialize(): Promise<void>;

  /**
   * Tear down the provider and release resources.
   *
   * Called during graceful shutdown. Implementations should cancel
   * in-flight requests and clear caches.
   */
  public abstract dispose(): Promise<void>;

  // ─── Health (abstract) ──────────────────────────────────────────────

  /**
   * Perform a health check against the upstream service.
   *
   * Implementations must update availability state via the protected
   * setters and return `true` if the provider is healthy.
   *
   * @returns `true` if the provider is available, `false` otherwise.
   */
  public abstract checkHealth(): Promise<boolean>;

  // ─── Core operations (abstract) ─────────────────────────────────────

  /**
   * Send a chat-completion request to the provider.
   *
   * @param messages - The conversation history as an array of {@link ChatMessage}.
   * @param options  - Optional {@link CompletionOptions} to customise the request.
   * @returns A {@link CompletionResult} containing the generated text, usage, and cost.
   *
   * @throws {Error} If the upstream API returns a non-OK response or a
   *                  network error occurs.
   */
  public abstract complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult>;

  /**
   * Retrieve the list of models available through this provider.
   *
   * @returns An array of {@link ModelInfo} describing each available model.
   */
  public abstract listModels(): Promise<ModelInfo[]>;

  // ─── Health status snapshot ─────────────────────────────────────────

  /**
   * Build a frozen {@link ProviderHealthStatus} snapshot of the current state.
   *
   * The returned object is deeply frozen so consumers cannot accidentally
   * mutate provider state. The {@link lastCheckTime} is cloned to prevent
   * external date mutations.
   *
   * @param modelCount - The number of models currently available through
   *                     this provider (typically from a cached model list).
   * @returns An immutable {@link ProviderHealthStatus} object.
   */
  public getHealthStatus(modelCount: number): ProviderHealthStatus {
    return Object.freeze({
      providerName: this.providerName,
      isAvailable: this._isAvailable,
      lastCheckTime: new Date(this._lastCheckTime.getTime()),
      lastError: this._lastError,
      modelCount,
    });
  }
}
