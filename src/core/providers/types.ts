/**
 * @fileoverview Shared type definitions used across the Nexus AI Gateway project.
 *
 * This module defines the canonical interfaces and types for chat messages,
 * completion requests/responses, model metadata, usage tracking, and provider
 * health monitoring. All provider implementations and routing logic depend on
 * these types.
 */

// ─── Chat Message ───────────────────────────────────────────────────────────

/**
 * Standard chat message format (OpenAI-compatible).
 *
 * Represents a single message in a conversation, identified by role.
 * Compatible with the OpenAI Chat Completions API and OpenRouter.
 */
export interface ChatMessage {
  /** The role of the message author. */
  role: 'system' | 'user' | 'assistant';

  /** The text content of the message. */
  content: string;
}

// ─── Completion Request / Response ──────────────────────────────────────────

/**
 * Options for a completion request.
 *
 * All fields are optional; providers will apply sensible defaults when
 * a value is omitted.
 */
export interface CompletionOptions {
  /** Model identifier to use for this request. */
  model?: string;

  /** Sampling temperature (0–2). Higher values increase randomness. */
  temperature?: number;

  /** Maximum number of tokens to generate in the completion. */
  maxTokens?: number;

  /** Nucleus-sampling probability mass (0–1). */
  topP?: number;

  /** Sequences where the model should stop generating further tokens. */
  stop?: string[];

  /** Whether to stream the response (server-sent events). */
  stream?: boolean;

  /** OpenRouter-specific: array of fallback model IDs tried in order. */
  fallbackModels?: string[];

  /** OpenRouter-specific: provider sort preference for routing. */
  providerSort?: 'price' | 'throughput' | 'latency';
}

/**
 * Result returned from a successful completion request.
 *
 * Contains the generated text, the model/provider that produced it,
 * token-usage statistics, measured latency, and optional cost data.
 */
export interface CompletionResult {
  /** The generated text content. */
  content: string;

  /** The model identifier that produced this completion. */
  model: string;

  /** The provider name that served this completion (e.g. 'openrouter', 'ollama'). */
  provider: string;

  /** Token-usage statistics for prompt and completion. */
  usage: TokenUsage;

  /** Wall-clock latency of the request in milliseconds. */
  latencyMs: number;

  /** Optional cost breakdown if the provider reports pricing. */
  cost?: CostBreakdown;
}

// ─── Token Usage & Cost ─────────────────────────────────────────────────────

/**
 * Token-usage statistics for a single completion request.
 */
export interface TokenUsage {
  /** Number of tokens in the prompt (input). */
  promptTokens: number;

  /** Number of tokens in the completion (output). */
  completionTokens: number;

  /** Total tokens consumed (prompt + completion). */
  totalTokens: number;
}

/**
 * Cost breakdown in USD for a single completion request.
 */
export interface CostBreakdown {
  /** Cost attributable to prompt (input) tokens. */
  promptCost: number;

  /** Cost attributable to completion (output) tokens. */
  completionCost: number;

  /** Total cost (prompt + completion). */
  totalCost: number;
}

// ─── Model Metadata ─────────────────────────────────────────────────────────

/**
 * Metadata describing a model available through a provider.
 *
 * Sourced from provider model catalogs and used by the routing engine
 * to make intelligent model-selection decisions.
 */
export interface ModelInfo {
  /** Unique model identifier (e.g. 'google/gemma-3-27b-it:free'). */
  id: string;

  /** Human-readable display name. */
  name: string;

  /** Provider that serves this model (e.g. 'openrouter', 'ollama'). */
  provider: string;

  /** Maximum context window size in tokens. */
  contextLength: number;

  /** Maximum number of tokens the model can generate per request. */
  maxCompletionTokens: number;

  /** Per-token pricing information. */
  pricing: ModelPricing;

  /** Supported input/output modalities. */
  modalities: ModelModalities;

  /** Parameter names this model supports (e.g. 'temperature', 'top_p'). */
  supportedParams: string[];

  /** Whether this model is free to use (zero cost). */
  isFree: boolean;
}

/**
 * Per-token pricing for a model.
 */
export interface ModelPricing {
  /** Cost per input token in USD. */
  prompt: number;

  /** Cost per output token in USD. */
  completion: number;
}

/**
 * Input and output modalities supported by a model.
 */
export interface ModelModalities {
  /** Accepted input modalities (e.g. ['text'], ['text', 'image']). */
  input: string[];

  /** Produced output modalities (e.g. ['text']). */
  output: string[];
}

// ─── Task Classification ────────────────────────────────────────────────────

/**
 * Task classification categories for intelligent routing.
 *
 * The routing engine uses these categories to select the most
 * appropriate model for a given request.
 */
export type TaskCategory =
  | 'coding'
  | 'creative'
  | 'analysis'
  | 'conversation'
  | 'summarization'
  | 'translation'
  | 'general';

// ─── Provider Health ────────────────────────────────────────────────────────

/**
 * Snapshot of a provider's current health status.
 *
 * Returned by {@link BaseAIProvider.getHealthStatus} and used by the
 * dashboard and routing engine.
 */
export interface ProviderHealthStatus {
  /** Name of the provider (e.g. 'openrouter', 'ollama'). */
  providerName: string;

  /** Whether the provider is currently reachable and operational. */
  isAvailable: boolean;

  /** Timestamp of the most recent health check. */
  lastCheckTime: Date;

  /** Description of the last error, if any. */
  lastError?: string;

  /** Number of models currently available through this provider. */
  modelCount: number;
}

// ─── Credits ────────────────────────────────────────────────────────────────

/**
 * Credit balance information for a pay-as-you-go provider.
 */
export interface CreditBalance {
  /** Total credits ever purchased or granted. */
  totalCredits: number;

  /** Total credits consumed so far. */
  totalUsage: number;

  /** Remaining available credits. */
  remaining: number;
}

// ─── Usage Tracking ─────────────────────────────────────────────────────────

/**
 * Record of a single API request for usage tracking.
 */
export interface UsageRecord {
  /** Unique identifier for this usage record. */
  id: string;

  /** When this request was made. */
  timestamp: Date;

  /** Provider that served the request. */
  provider: string;

  /** Model used for the request. */
  model: string;

  /** Classified task category. */
  taskCategory: TaskCategory;

  /** Token-usage statistics. */
  usage: TokenUsage;

  /** Wall-clock latency in milliseconds. */
  latencyMs: number;

  /** Optional cost breakdown. */
  cost?: CostBreakdown;

  /** Description of the routing decision that was made. */
  routingDecision: string;

  /** IP address of the client, if available. */
  clientIp?: string;
}

/**
 * Aggregated usage statistics snapshot.
 *
 * Provides a high-level view of system usage across all providers,
 * models, and task categories. Used by the dashboard.
 */
export interface UsageSnapshot {
  /** Total number of requests served. */
  totalRequests: number;

  /** Total tokens consumed across all requests. */
  totalTokens: number;

  /** Total cost in USD across all requests. */
  totalCost: number;

  /** Request count grouped by provider name. */
  requestsByProvider: Record<string, number>;

  /** Request count grouped by model identifier. */
  requestsByModel: Record<string, number>;

  /** Request count grouped by task category. */
  requestsByTask: Record<string, number>;

  /** Average latency (ms) grouped by provider name. */
  avgLatencyByProvider: Record<string, number>;

  /** Most recent usage records (typically the last N). */
  recentRequests: UsageRecord[];

  /** Current credit balance, if applicable. */
  creditBalance?: CreditBalance;
}
