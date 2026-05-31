/**
 * @file model-profiles.ts
 * @description Model preference profiles for task-based routing. Maps each
 * {@link TaskCategory} to an ordered list of preferred model ID patterns,
 * enabling the {@link ModelRouter} to select the best model for a given task.
 */

import { TaskCategory } from '../core/providers/types';

/**
 * Ordered preference lists of model IDs for each task category.
 *
 * The router iterates these arrays in order, selecting the first model that
 * is available in the live registry. This allows graceful degradation: if the
 * top-choice model is offline or unavailable, the next-best is tried.
 *
 * @remarks
 * Model IDs follow the OpenRouter `provider/model` naming convention.
 * Ollama models may use a simpler naming scheme.
 */
export const MODEL_TASK_PREFERENCES: Record<TaskCategory, string[]> = {
  coding: [
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'deepseek/deepseek-coder-v2',
    'meta-llama/llama-4-scout',
  ],
  creative: [
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'google/gemini-2.5-flash',
  ],
  analysis: [
    'google/gemini-2.5-flash',
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
  ],
  conversation: [
    'google/gemma-3-27b-it:free',
    'meta-llama/llama-4-scout',
    'google/gemini-2.5-flash',
  ],
  summarization: [
    'google/gemini-2.5-flash',
    'anthropic/claude-3.5-haiku',
    'meta-llama/llama-4-scout',
  ],
  translation: [
    'openai/gpt-4o',
    'google/gemini-2.5-flash',
    'anthropic/claude-3.5-haiku',
  ],
  general: [
    'google/gemma-3-27b-it:free',
    'meta-llama/llama-4-scout',
    'google/gemini-2.5-flash',
  ],
};

/**
 * Default free models to fall back on when paid models are unavailable
 * or the user's credit balance is depleted.
 *
 * @remarks
 * These models are tagged `:free` by OpenRouter and incur no API cost.
 */
export const DEFAULT_FREE_MODELS: string[] = [
  'google/gemma-3-27b-it:free',
  'deepseek/deepseek-r1-0528:free',
  'meta-llama/llama-4-maverick:free',
  'microsoft/phi-4-reasoning-plus:free',
];
