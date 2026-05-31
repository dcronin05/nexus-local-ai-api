/**
 * @file ModelRegistry.ts
 * @description Maintains a live, periodically refreshed catalog of models
 * from all registered AI providers. Acts as the single source of truth for
 * model availability, enabling the {@link ModelRouter} to make informed
 * routing decisions.
 */

import { ModelInfo } from '../providers/types';
import { BaseAIProvider } from '../providers/BaseAIProvider';

/**
 * A centralized registry that aggregates model catalogs from all configured
 * AI providers and keeps them fresh via periodic polling.
 *
 * @remarks
 * The registry merges models from multiple providers into a single map keyed
 * by model ID. It also maintains a per-provider index for fast lookups.
 * If one provider fails during a refresh, the others are still updated.
 *
 * @example
 * ```typescript
 * const registry = new ModelRegistry([openRouterProvider, ollamaProvider]);
 * await registry.start();
 *
 * const allModels = registry.getAllModels();
 * const freeModels = registry.getFreeModels();
 *
 * registry.stop();
 * ```
 */
export class ModelRegistry {
  /** All known models keyed by model ID. */
  private readonly _models: Map<string, ModelInfo>;

  /** Models grouped by provider name. */
  private readonly _providerModels: Map<string, ModelInfo[]>;

  /** Handle for the periodic refresh timer, or `null` if stopped. */
  private _pollTimer: NodeJS.Timeout | null;

  /** The registered providers to poll for model catalogs. */
  private readonly _providers: BaseAIProvider[];

  /** Interval in milliseconds between automatic refreshes. */
  private readonly _pollIntervalMs: number;

  /**
   * Creates a new ModelRegistry.
   *
   * @param providers - The AI providers whose model catalogs should be aggregated.
   *   Must contain at least one provider.
   * @param pollIntervalMs - Interval between automatic refresh polls, in
   *   milliseconds. Defaults to 300 000 (5 minutes). Must be a positive integer.
   * @throws {Error} If `providers` is empty or `pollIntervalMs` is not a
   *   positive number.
   */
  public constructor(providers: BaseAIProvider[], pollIntervalMs: number = 300_000) {
    if (!providers || providers.length === 0) {
      throw new Error('ModelRegistry requires at least one provider.');
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error(`pollIntervalMs must be a positive number, received: ${pollIntervalMs}`);
    }

    this._providers = providers;
    this._pollIntervalMs = pollIntervalMs;
    this._models = new Map<string, ModelInfo>();
    this._providerModels = new Map<string, ModelInfo[]>();
    this._pollTimer = null;
  }

  /**
   * Starts the registry by performing an initial refresh and scheduling
   * periodic polling.
   *
   * @remarks
   * Safe to call multiple times — subsequent calls are no-ops if the
   * registry is already running.
   */
  public async start(): Promise<void> {
    await this.refresh();

    if (this._pollTimer === null) {
      this._pollTimer = setInterval(() => {
        this.refresh().catch((err) => {
          console.error('[ModelRegistry] Unhandled error during periodic refresh:', err);
        });
      }, this._pollIntervalMs);
    }
  }

  /**
   * Stops periodic polling and clears the refresh timer.
   *
   * @remarks
   * Does not clear the cached model data. Calling {@link start} again will
   * resume polling.
   */
  public stop(): void {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Refreshes the model catalog by querying every registered provider.
   *
   * @remarks
   * Each provider is queried independently. If one provider throws, its
   * error is logged and the others continue. The internal maps are rebuilt
   * with fresh data on each refresh.
   */
  public async refresh(): Promise<void> {
    const freshModels = new Map<string, ModelInfo>();
    const freshProviderModels = new Map<string, ModelInfo[]>();

    for (const provider of this._providers) {
      const providerName = provider.providerName;
      try {
        const models = await provider.listModels();
        freshProviderModels.set(providerName, models);

        for (const model of models) {
          freshModels.set(model.id, model);
        }

        console.log(
          `[ModelRegistry] Loaded ${models.length} model(s) from provider "${providerName}".`
        );
      } catch (err) {
        console.error(
          `[ModelRegistry] Failed to load models from provider "${providerName}":`,
          err instanceof Error ? err.message : err
        );
        // Preserve any previously cached models for this provider
        const existing = this._providerModels.get(providerName);
        if (existing) {
          freshProviderModels.set(providerName, existing);
          for (const model of existing) {
            freshModels.set(model.id, model);
          }
        }
      }
    }

    // Atomically swap the maps
    this._models.clear();
    for (const [id, model] of freshModels) {
      this._models.set(id, model);
    }

    this._providerModels.clear();
    for (const [name, models] of freshProviderModels) {
      this._providerModels.set(name, models);
    }

    console.log(`[ModelRegistry] Refresh complete. Total models: ${this._models.size}.`);
  }

  /**
   * Returns all known models across all providers.
   *
   * @returns An array of every {@link ModelInfo} in the registry.
   */
  public getAllModels(): ModelInfo[] {
    return Array.from(this._models.values());
  }

  /**
   * Looks up a single model by its unique ID.
   *
   * @param id - The model ID (e.g. `'anthropic/claude-sonnet-4'`).
   * @returns The {@link ModelInfo} if found, or `undefined`.
   */
  public getModelById(id: string): ModelInfo | undefined {
    return this._models.get(id);
  }

  /**
   * Returns all models provided by a specific provider.
   *
   * @param providerName - The provider name (e.g. `'openrouter'`, `'ollama'`).
   * @returns An array of {@link ModelInfo} for the provider, or an empty
   *   array if the provider has no registered models.
   */
  public getModelsByProvider(providerName: string): ModelInfo[] {
    return this._providerModels.get(providerName) ?? [];
  }

  /**
   * Returns all models marked as free (no cost per token).
   *
   * @returns An array of free {@link ModelInfo} entries.
   */
  public getFreeModels(): ModelInfo[] {
    return Array.from(this._models.values()).filter((model) => model.isFree);
  }

  /**
   * Finds all models that support a given parameter or capability.
   *
   * @param param - The parameter name to search for (e.g. `'temperature'`,
   *   `'tools'`, `'json_mode'`).
   * @returns An array of models whose `supportedParams` includes the
   *   specified parameter.
   */
  public findModelsByCapability(param: string): ModelInfo[] {
    return Array.from(this._models.values()).filter(
      (model) => model.supportedParams && model.supportedParams.includes(param)
    );
  }

  /**
   * Returns the total number of models currently in the registry.
   *
   * @returns The model count.
   */
  public getModelCount(): number {
    return this._models.size;
  }
}
