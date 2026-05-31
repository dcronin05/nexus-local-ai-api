/**
 * @fileoverview Concrete AI provider implementation for the OpenRouter API.
 *
 * {@link OpenRouterProvider} communicates with the OpenRouter unified API
 * to provide access to hundreds of cloud-hosted language models. It supports
 * fallback-model routing, provider-sort preferences, and credit-balance
 * queries.
 *
 * All network calls use the native `fetch()` API with an {@link AbortController}
 * timeout to prevent hanging requests.
 *
 * @see https://openrouter.ai/docs
 */

import { BaseAIProvider } from './BaseAIProvider';
import {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  CreditBalance,
  ModelInfo,
  TokenUsage,
} from './types';

/**
 * AI provider backed by the OpenRouter unified API.
 *
 * OpenRouter aggregates many upstream model providers (OpenAI, Anthropic,
 * Google, Meta, etc.) behind a single API key. This class wraps that API
 * with health checking, model catalog retrieval, chat completion, and
 * credit-balance queries.
 *
 * @example
 * ```typescript
 * const provider = new OpenRouterProvider('sk-or-…');
 * await provider.initialize();
 * const result = await provider.complete([{ role: 'user', content: 'Hello!' }]);
 * console.log(result.content);
 * ```
 */
export class OpenRouterProvider extends BaseAIProvider {
  // ─── Private readonly backing fields ────────────────────────────────

  /** Bearer token for the OpenRouter API. */
  private readonly _apiKey: string;

  /** Model used when none is specified in {@link CompletionOptions}. */
  private readonly _defaultModel: string;

  /** Application title sent in the `X-Title` header. */
  private readonly _appTitle: string;

  /** Root URL for all OpenRouter API requests. */
  private readonly _baseUrl: string = 'https://openrouter.ai/api/v1';

  /** Default request timeout in milliseconds. */
  private static readonly _REQUEST_TIMEOUT_MS: number = 30_000;

  // ─── Constructor ────────────────────────────────────────────────────

  /**
   * Create a new {@link OpenRouterProvider}.
   *
   * @param apiKey       - OpenRouter API key (must be a non-empty string).
   * @param defaultModel - Model identifier to use when none is specified
   *                       in a completion request. Defaults to
   *                       `'google/gemma-3-27b-it:free'`.
   * @param appTitle     - Application title sent in the `X-Title` request
   *                       header. Defaults to `'Nexus AI Gateway'`.
   *
   * @throws {Error} If `apiKey` is empty or not a string.
   */
  public constructor(
    apiKey: string,
    defaultModel: string = 'google/gemma-3-27b-it:free',
    appTitle: string = 'Nexus AI Gateway',
  ) {
    super();

    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new Error('OpenRouterProvider: apiKey must be a non-empty string.');
    }
    if (typeof defaultModel !== 'string' || defaultModel.trim().length === 0) {
      throw new Error('OpenRouterProvider: defaultModel must be a non-empty string.');
    }
    if (typeof appTitle !== 'string' || appTitle.trim().length === 0) {
      throw new Error('OpenRouterProvider: appTitle must be a non-empty string.');
    }

    this._apiKey = apiKey;
    this._defaultModel = defaultModel;
    this._appTitle = appTitle;
  }

  // ─── Identity ───────────────────────────────────────────────────────

  /** @inheritdoc */
  public get providerName(): string {
    return 'openrouter';
  }

  /** The default model identifier used when none is provided. */
  public get defaultModel(): string {
    return this._defaultModel;
  }

  /** The application title sent in request headers. */
  public get appTitle(): string {
    return this._appTitle;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialise the provider by performing an initial health check.
   *
   * Logs the result to the console. Does not throw on failure so the
   * gateway can continue operating with other providers.
   */
  public async initialize(): Promise<void> {
    const healthy = await this.checkHealth();
    if (healthy) {
      console.log(`[OpenRouterProvider] Initialized successfully.`);
    } else {
      console.warn(
        `[OpenRouterProvider] Initialization health check failed: ${this.lastError ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Dispose of the provider.
   *
   * OpenRouter is stateless so there is nothing to tear down, but we
   * mark the provider as unavailable.
   */
  public async dispose(): Promise<void> {
    this.setAvailable(false);
    console.log('[OpenRouterProvider] Disposed.');
  }

  // ─── Health ─────────────────────────────────────────────────────────

  /**
   * Check provider health by validating the API key against `/auth/key`.
   *
   * Updates internal availability state and records the check time.
   *
   * @returns `true` if the API key is valid and the service is reachable.
   */
  public async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        OpenRouterProvider._REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await fetch(`${this._baseUrl}/auth/key`, {
          method: 'GET',
          headers: this._buildHeaders(),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          this._handleError(response, body);
        }

        this.setAvailable(true);
        this.setLastError(undefined);
        return true;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.setAvailable(false);
      this.setLastError(message);
      return false;
    } finally {
      this.setLastCheckTime(new Date());
    }
  }

  // ─── Core operations ───────────────────────────────────────────────

  /**
   * Send a chat-completion request to OpenRouter.
   *
   * Supports fallback models (via `options.fallbackModels`) and provider
   * sort preferences (via `options.providerSort`).
   *
   * @param messages - Conversation history.
   * @param options  - Optional completion parameters.
   * @returns A {@link CompletionResult} with the generated text and metadata.
   *
   * @throws {Error} If the API returns a non-OK status or a network error occurs.
   */
  public async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('OpenRouterProvider.complete: messages must be a non-empty array.');
    }

    const model = options?.model ?? this._defaultModel;

    // Build request body
    const body: Record<string, unknown> = {
      model,
      messages,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options?.stop !== undefined) {
      body.stop = options.stop;
    }
    if (options?.stream !== undefined) {
      body.stream = options.stream;
    }

    // OpenRouter-specific: fallback models
    if (options?.fallbackModels && options.fallbackModels.length > 0) {
      body.models = [model, ...options.fallbackModels];
      body.route = 'fallback';
    }

    // OpenRouter-specific: provider sort
    if (options?.providerSort) {
      body.provider = { sort: options.providerSort };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OpenRouterProvider._REQUEST_TIMEOUT_MS,
    );

    const startTime = Date.now();

    try {
      const response = await fetch(`${this._baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;
      const responseBody: any = await response.json();

      if (!response.ok) {
        this._handleError(response, JSON.stringify(responseBody));
      }

      // Extract content from the first choice
      const choice = responseBody.choices?.[0];
      const content: string = choice?.message?.content ?? '';

      // Extract usage
      const rawUsage = responseBody.usage ?? {};
      const usage: TokenUsage = {
        promptTokens: rawUsage.prompt_tokens ?? 0,
        completionTokens: rawUsage.completion_tokens ?? 0,
        totalTokens: rawUsage.total_tokens ?? 0,
      };

      // Calculate cost if pricing is available
      const completionModel: string = responseBody.model ?? model;

      const result: CompletionResult = {
        content,
        model: completionModel,
        provider: this.providerName,
        usage,
        latencyMs,
      };

      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List all models available through OpenRouter.
   *
   * Fetches the public `/models` endpoint (no authentication required)
   * and maps each entry to a {@link ModelInfo}.
   *
   * @returns An array of {@link ModelInfo} objects.
   */
  public async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OpenRouterProvider._REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this._baseUrl}/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        this._handleError(response, body);
      }

      const responseBody: any = await response.json();
      const models: unknown[] = responseBody.data ?? [];

      return models.map((raw: unknown) => {
        const m = raw as Record<string, unknown>;
        const pricing = m.pricing as Record<string, string> | undefined;
        const architecture = m.architecture as Record<string, unknown> | undefined;
        const topProvider = m.top_provider as Record<string, unknown> | undefined;

        const promptPrice = parseFloat(pricing?.prompt ?? '0');
        const completionPrice = parseFloat(pricing?.completion ?? '0');

        const modelInfo: ModelInfo = {
          id: String(m.id ?? ''),
          name: String(m.name ?? ''),
          provider: this.providerName,
          contextLength: Number(m.context_length ?? 0),
          maxCompletionTokens: Number(topProvider?.max_completion_tokens ?? 0),
          pricing: {
            prompt: promptPrice,
            completion: completionPrice,
          },
          modalities: {
            input: Array.isArray(architecture?.input_modalities)
              ? (architecture.input_modalities as string[])
              : ['text'],
            output: Array.isArray(architecture?.output_modalities)
              ? (architecture.output_modalities as string[])
              : ['text'],
          },
          supportedParams: Array.isArray(m.supported_parameters)
            ? (m.supported_parameters as string[])
            : [],
          isFree: pricing?.prompt === '0' && pricing?.completion === '0',
        };

        return modelInfo;
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── Credit balance ─────────────────────────────────────────────────

  /**
   * Retrieve the current credit balance from OpenRouter.
   *
   * @returns A {@link CreditBalance} with total, used, and remaining credits.
   *
   * @throws {Error} If the API returns a non-OK status or a network error occurs.
   */
  public async getCredits(): Promise<CreditBalance> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OpenRouterProvider._REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this._baseUrl}/credits`, {
        method: 'GET',
        headers: this._buildHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        this._handleError(response, body);
      }

      const responseBody: any = await response.json();
      const data = responseBody.data ?? responseBody;

      const totalCredits = Number(data.total_credits ?? 0);
      const totalUsage = Number(data.total_usage ?? 0);

      return {
        totalCredits,
        totalUsage,
        remaining: totalCredits - totalUsage,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Build the standard HTTP headers for OpenRouter API requests.
   *
   * @returns A headers object with Authorization, Content-Type,
   *          HTTP-Referer, and X-Title.
   */
  private _buildHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3060',
      'X-Title': this._appTitle,
    };
  }

  /**
   * Classify an error response and throw a descriptive {@link Error}.
   *
   * @param response - The fetch {@link Response} object.
   * @param body     - The raw response body as a string.
   *
   * @throws {Error} Always — this method never returns normally.
   */
  private _handleError(response: Response, body: string): never {
    let errorMessage: string;

    try {
      const parsed = JSON.parse(body);
      errorMessage =
        parsed.error?.message ??
        parsed.error ??
        parsed.message ??
        body;
    } catch {
      errorMessage = body;
    }

    switch (response.status) {
      case 401:
        throw new Error(
          `OpenRouter authentication failed (401): ${errorMessage}`,
        );
      case 402:
        throw new Error(
          `OpenRouter insufficient credits (402): ${errorMessage}`,
        );
      case 429:
        throw new Error(
          `OpenRouter rate limit exceeded (429): ${errorMessage}`,
        );
      case 503:
        throw new Error(
          `OpenRouter service unavailable (503): ${errorMessage}`,
        );
      default:
        throw new Error(
          `OpenRouter API error (${response.status}): ${errorMessage}`,
        );
    }
  }
}
