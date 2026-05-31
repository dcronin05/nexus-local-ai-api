/**
 * @fileoverview Concrete AI provider implementation for Ollama's local API.
 *
 * {@link OllamaProvider} communicates with a locally-running Ollama instance
 * to provide access to open-weight language models (Llama, Mistral, etc.)
 * at zero cost. It uses the OpenAI-compatible `/v1/chat/completions`
 * endpoint for completions and the native `/api/tags` endpoint for health
 * checks and model listing.
 *
 * Because Ollama runs locally and may not always be available, health-check
 * failures are logged as warnings rather than thrown as errors.
 *
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import { BaseAIProvider } from './BaseAIProvider';
import {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  ModelInfo,
  TokenUsage,
} from './types';

/**
 * AI provider backed by a local Ollama instance.
 *
 * All models served through Ollama are free (no API cost). The provider
 * uses longer timeouts for completions because local inference on CPU
 * or consumer GPUs can be significantly slower than cloud endpoints.
 *
 * @example
 * ```typescript
 * const provider = new OllamaProvider('http://localhost:11434', 'llama3.1');
 * await provider.initialize();
 * const result = await provider.complete([{ role: 'user', content: 'Hello!' }]);
 * console.log(result.content);
 * ```
 */
export class OllamaProvider extends BaseAIProvider {
  // ─── Private readonly backing fields ────────────────────────────────

  /** Base URL of the Ollama API (e.g. `http://localhost:11434`). */
  private readonly _host: string;

  /** Model used when none is specified in {@link CompletionOptions}. */
  private readonly _defaultModel: string;

  /** Timeout for completion requests in milliseconds (local models can be slow). */
  private static readonly _COMPLETION_TIMEOUT_MS: number = 60_000;

  /** Timeout for health-check and metadata requests in milliseconds. */
  private static readonly _HEALTH_TIMEOUT_MS: number = 10_000;

  // ─── Constructor ────────────────────────────────────────────────────

  /**
   * Create a new {@link OllamaProvider}.
   *
   * @param host         - Base URL of the Ollama API. Defaults to
   *                       `'http://localhost:11434'`.
   * @param defaultModel - Model identifier to use when none is specified
   *                       in a completion request. Defaults to `'llama3.1'`.
   *
   * @throws {Error} If `host` or `defaultModel` is empty or not a string.
   */
  public constructor(
    host: string = 'http://localhost:11434',
    defaultModel: string = 'llama3.1',
  ) {
    super();

    if (typeof host !== 'string' || host.trim().length === 0) {
      throw new Error('OllamaProvider: host must be a non-empty string.');
    }
    if (typeof defaultModel !== 'string' || defaultModel.trim().length === 0) {
      throw new Error('OllamaProvider: defaultModel must be a non-empty string.');
    }

    // Strip trailing slash for consistent URL construction
    this._host = host.replace(/\/+$/, '');
    this._defaultModel = defaultModel;
  }

  // ─── Identity ───────────────────────────────────────────────────────

  /** @inheritdoc */
  public get providerName(): string {
    return 'ollama';
  }

  /** The base URL of the Ollama instance. */
  public get host(): string {
    return this._host;
  }

  /** The default model identifier used when none is provided. */
  public get defaultModel(): string {
    return this._defaultModel;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialise the provider by performing an initial health check.
   *
   * Logs the result to the console. Because Ollama is a local service
   * that may simply not be running, failures are logged as warnings
   * rather than thrown.
   */
  public async initialize(): Promise<void> {
    const healthy = await this.checkHealth();
    if (healthy) {
      console.log('[OllamaProvider] Initialized successfully — Ollama is available.');
    } else {
      console.warn(
        `[OllamaProvider] Ollama is not available at ${this._host}. ` +
          'Local models will be unavailable until Ollama is started.',
      );
    }
  }

  /**
   * Dispose of the provider.
   *
   * Ollama is managed externally so there is nothing to tear down,
   * but we mark the provider as unavailable.
   */
  public async dispose(): Promise<void> {
    this.setAvailable(false);
    console.log('[OllamaProvider] Disposed.');
  }

  // ─── Health ─────────────────────────────────────────────────────────

  /**
   * Check whether the Ollama instance is reachable by querying `/api/tags`.
   *
   * Unlike cloud providers, Ollama may legitimately be offline (the user
   * simply hasn't started the daemon). Failures are therefore treated as
   * warnings — this method never throws.
   *
   * @returns `true` if Ollama responded successfully, `false` otherwise.
   */
  public async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        OllamaProvider._HEALTH_TIMEOUT_MS,
      );

      try {
        const response = await fetch(`${this._host}/api/tags`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (response.ok) {
          this.setAvailable(true);
          this.setLastError(undefined);
          return true;
        }

        const body = await response.text();
        this.setAvailable(false);
        this.setLastError(
          `Ollama returned HTTP ${response.status}: ${body}`,
        );
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.setAvailable(false);
      this.setLastError(message);
      console.warn(`[OllamaProvider] Health check failed: ${message}`);
      return false;
    } finally {
      this.setLastCheckTime(new Date());
    }
  }

  // ─── Core operations ───────────────────────────────────────────────

  /**
   * Send a chat-completion request via Ollama's OpenAI-compatible endpoint.
   *
   * Uses `POST {host}/v1/chat/completions` with `stream: false` for
   * synchronous responses. If a network error occurs the provider is
   * marked unavailable and the error is re-thrown.
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
      throw new Error('OllamaProvider.complete: messages must be a non-empty array.');
    }

    const model = options?.model ?? this._defaultModel;

    // Build request body (OpenAI-compatible format)
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
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
    if (options?.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools;
    }
    if (options?.toolChoice !== undefined) {
      body.tool_choice = options.toolChoice;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OllamaProvider._COMPLETION_TIMEOUT_MS,
    );

    const startTime = Date.now();

    try {
      const response = await fetch(`${this._host}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ollama',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Ollama API error (${response.status}): ${errorBody}`,
        );
      }

      const responseBody: any = await response.json();

      // Extract content from the first choice (OpenAI format)
      const choice = responseBody.choices?.[0];
      const content: string | null = choice?.message?.content ?? null;
      const toolCalls = choice?.message?.tool_calls;
      const finishReason: string | undefined = choice?.finish_reason;

      // Extract usage
      const rawUsage = responseBody.usage ?? {};
      const usage: TokenUsage = {
        promptTokens: rawUsage.prompt_tokens ?? 0,
        completionTokens: rawUsage.completion_tokens ?? 0,
        totalTokens: rawUsage.total_tokens ?? 0,
      };

      const completionModel: string = responseBody.model ?? model;

      const result: CompletionResult = {
        content,
        model: completionModel,
        provider: this.providerName,
        usage,
        latencyMs,
        toolCalls,
        finishReason,
      };

      return result;
    } catch (error: unknown) {
      // Network errors mean Ollama is likely down — mark unavailable
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')) {
        this.setAvailable(false);
        const message =
          error instanceof Error ? error.message : String(error);
        this.setLastError(message);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List all models currently pulled/available in the local Ollama instance.
   *
   * Queries `GET {host}/api/tags` and maps each model to a {@link ModelInfo}.
   * Because Ollama does not report context-window sizes, sensible defaults
   * are used (4 096 context, 2 048 max completion).
   *
   * @returns An array of {@link ModelInfo} objects.
   *
   * @throws {Error} If the API returns a non-OK status or a network error occurs.
   */
  public async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OllamaProvider._HEALTH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this._host}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Ollama API error (${response.status}): ${body}`,
        );
      }

      const responseBody: any = await response.json();
      const models: unknown[] = responseBody.models ?? [];

      return models.map((raw: unknown) => {
        const m = raw as Record<string, unknown>;
        const name = String(m.name ?? '');

        const modelInfo: ModelInfo = {
          id: name,
          name,
          provider: this.providerName,
          contextLength: 4096,
          maxCompletionTokens: 2048,
          pricing: {
            prompt: 0,
            completion: 0,
          },
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          supportedParams: ['temperature', 'max_tokens', 'top_p', 'stop'],
          isFree: true,
        };

        return modelInfo;
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
