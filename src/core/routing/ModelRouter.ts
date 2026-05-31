/**
 * @file ModelRouter.ts
 * @description The central routing engine of the Nexus AI Gateway. Selects
 * the best model for a given task by combining heuristic classification,
 * preference profiles, and live model availability — then executes the
 * completion with multi-provider fallback.
 */

import {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  TaskCategory,
  CreditBalance,
  ProviderHealthStatus,
} from '../providers/types';
import { BaseAIProvider } from '../providers/BaseAIProvider';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { ModelRegistry } from './ModelRegistry';
import { TaskClassifier } from './TaskClassifier';
import { MODEL_TASK_PREFERENCES } from '../../config/model-profiles';

/**
 * Extended completion result that includes routing metadata.
 *
 * @remarks
 * Consumers can inspect `taskCategory` and `routingDecision` to understand
 * why a particular model was selected.
 */
export interface RoutedCompletionResult extends CompletionResult {
  /** The detected task category that influenced model selection. */
  readonly taskCategory: TaskCategory;
  /** A human-readable string describing the routing decision. */
  readonly routingDecision: string;
}

/**
 * The intelligent routing engine that selects the optimal model and provider
 * for each completion request.
 *
 * @remarks
 * Routing logic follows this priority chain:
 * 1. If the client explicitly specifies a model, use it (with fallback).
 * 2. Otherwise, classify the task and consult {@link MODEL_TASK_PREFERENCES}.
 * 3. For each preferred model, try providers in priority order.
 * 4. If all preferred models fail, try any available model on each provider.
 * 5. If everything fails, throw with a comprehensive error message.
 *
 * @example
 * ```typescript
 * const router = new ModelRouter(providers, registry, ['openrouter', 'ollama']);
 * const result = await router.complete([
 *   { role: 'user', content: 'Write a sorting algorithm in Rust' }
 * ]);
 * console.log(result.routingDecision);
 * // 'auto:coding→anthropic/claude-sonnet-4@openrouter'
 * ```
 */
export class ModelRouter {
  /** Registered providers keyed by provider name. */
  private readonly _providers: Map<string, BaseAIProvider>;

  /** Live model catalog. */
  private readonly _registry: ModelRegistry;

  /** Ordered list of provider names from highest to lowest priority. */
  private readonly _providerPriority: string[];

  /** The heuristic task classifier. */
  private readonly _classifier: TaskClassifier;

  /** Cached credit balance from the OpenRouter provider. */
  private _creditBalance: CreditBalance | null;

  /**
   * Creates a new ModelRouter.
   *
   * @param providers - A map of provider names to provider instances
   *   (e.g. `'openrouter' → OpenRouterProvider`).
   * @param registry - The live model registry to consult for availability.
   * @param providerPriority - Ordered list of provider names indicating
   *   fallback priority. First entry is tried first.
   * @throws {Error} If `providers` is empty or `providerPriority` is empty.
   */
  public constructor(
    providers: Map<string, BaseAIProvider>,
    registry: ModelRegistry,
    providerPriority: string[]
  ) {
    if (!providers || providers.size === 0) {
      throw new Error('ModelRouter requires at least one provider.');
    }
    if (!providerPriority || providerPriority.length === 0) {
      throw new Error('ModelRouter requires a non-empty providerPriority list.');
    }
    if (!registry) {
      throw new Error('ModelRouter requires a ModelRegistry instance.');
    }

    this._providers = providers;
    this._registry = registry;
    this._providerPriority = providerPriority;
    this._classifier = new TaskClassifier();
    this._creditBalance = null;
  }

  /**
   * The most recently fetched credit balance, or `null` if not yet retrieved.
   */
  public get creditBalance(): CreditBalance | null {
    return this._creditBalance;
  }

  /**
   * Executes a chat completion by intelligently selecting a model and
   * provider, with full fallback logic.
   *
   * @param messages - The conversation history to complete.
   * @param options - Optional completion parameters (model, temperature, etc.).
   * @returns A {@link RoutedCompletionResult} containing the completion plus
   *   routing metadata.
   * @throws {Error} If no provider could successfully complete the request
   *   after exhausting all fallback options.
   */
  public async complete(
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<RoutedCompletionResult> {
    const errors: string[] = [];

    // ----- Path 1: Client-specified model -----
    if (options?.model) {
      const specifiedModel = options.model;
      const result = await this._tryModelAcrossProviders(
        specifiedModel,
        messages,
        options,
        errors
      );
      if (result) {
        return {
          ...result,
          taskCategory: this._classifier.classify(messages),
          routingDecision: `client-specified→${specifiedModel}@${result.provider}`,
        };
      }

      throw new Error(
        `Failed to complete with client-specified model "${specifiedModel}". ` +
          `Attempted providers: ${errors.join('; ')}`
      );
    }

    // ----- Path 2: Auto-route based on task classification -----
    const taskCategory = this._classifier.classify(messages);
    const preferredModels = MODEL_TASK_PREFERENCES[taskCategory] ?? [];

    // Try each preferred model in order
    for (const modelId of preferredModels) {
      const modelInfo = this._registry.getModelById(modelId);
      if (!modelInfo) {
        continue; // Model not available in any provider
      }

      const result = await this._tryModelAcrossProviders(
        modelId,
        messages,
        options,
        errors
      );
      if (result) {
        return {
          ...result,
          taskCategory,
          routingDecision: `auto:${taskCategory}→${modelId}@${result.provider}`,
        };
      }
    }

    // ----- Path 3: Fallback to any available model on each provider -----
    for (const providerName of this._providerPriority) {
      const provider = this._providers.get(providerName);
      if (!provider) {
        continue;
      }

      try {
        const result = await provider.complete(messages, options);
        return {
          ...result,
          taskCategory,
          routingDecision: `fallback:${taskCategory}→default@${providerName}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${providerName}(default): ${message}`);
        console.error(
          `[ModelRouter] Fallback failed on provider "${providerName}":`,
          message
        );
      }
    }

    // ----- All paths exhausted -----
    throw new Error(
      `[ModelRouter] All routing attempts failed for task "${taskCategory}". ` +
        `Tried ${preferredModels.length} preferred model(s) and ` +
        `${this._providerPriority.length} provider fallback(s). ` +
        `Errors: ${errors.join('; ')}`
    );
  }

  /**
   * Returns health status information for all registered providers.
   *
   * @returns An array of {@link ProviderHealthStatus} objects, one per provider.
   */
  public getProviderStatus(): ProviderHealthStatus[] {
    const statuses: ProviderHealthStatus[] = [];

    for (const [name, provider] of this._providers) {
      const modelCount = this._registry.getModelsByProvider(name).length;
      statuses.push(provider.getHealthStatus(modelCount));
    }

    return statuses;
  }

  /**
   * Refreshes the cached credit balance by querying the OpenRouter provider.
   *
   * @returns The updated {@link CreditBalance}, or `null` if no OpenRouter
   *   provider is configured.
   */
  public async refreshCredits(): Promise<CreditBalance | null> {
    const openRouterProvider = this._providers.get('openrouter');

    if (openRouterProvider && openRouterProvider instanceof OpenRouterProvider) {
      try {
        this._creditBalance = await openRouterProvider.getCredits();
        return this._creditBalance;
      } catch (err) {
        console.error(
          '[ModelRouter] Failed to refresh credits:',
          err instanceof Error ? err.message : err
        );
        return this._creditBalance;
      }
    }

    return null;
  }

  /**
   * Attempts to complete a request with a specific model across all providers
   * in priority order.
   *
   * @param modelId - The model ID to request.
   * @param messages - The conversation history.
   * @param options - Optional completion parameters.
   * @param errors - Accumulator for error messages from failed attempts.
   * @returns The {@link CompletionResult} if successful, or `null` if all
   *   providers failed.
   */
  private async _tryModelAcrossProviders(
    modelId: string,
    messages: ChatMessage[],
    options: CompletionOptions | undefined,
    errors: string[]
  ): Promise<CompletionResult | null> {
    const optionsWithModel: CompletionOptions = { ...options, model: modelId };

    for (const providerName of this._providerPriority) {
      const provider = this._providers.get(providerName);
      if (!provider) {
        continue;
      }

      try {
        const result = await provider.complete(messages, optionsWithModel);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${providerName}(${modelId}): ${message}`);
        console.error(
          `[ModelRouter] Provider "${providerName}" failed for model "${modelId}":`,
          message
        );
      }
    }

    return null;
  }
}
