/**
 * @file index.ts
 * @description Entry point for the Nexus AI Gateway service.
 * Bootstraps all providers, the model registry, the routing engine,
 * the usage tracker, and the HTTP server.
 */

import * as dotenv from 'dotenv';
import { OpenRouterProvider } from './core/providers/OpenRouterProvider';
import { OllamaProvider } from './core/providers/OllamaProvider';
import { BaseAIProvider } from './core/providers/BaseAIProvider';
import { ModelRegistry } from './core/routing/ModelRegistry';
import { ModelRouter } from './core/routing/ModelRouter';
import { UsageTracker } from './core/tracking/UsageTracker';
import { NexusServer } from './api/NexusServer';

// Load environment variables
dotenv.config();

/**
 * Main bootstrap function for the Nexus AI Gateway.
 */
async function main(): Promise<void> {
  console.log('[Nexus] Starting Nexus AI Gateway...');

  // ── Configuration ──────────────────────────────────────────────────
  const port = parseInt(process.env.NEXUS_PORT || '3060', 10);
  const host = process.env.NEXUS_HOST || '0.0.0.0';

  const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
  const openRouterDefaultModel = process.env.OPENROUTER_DEFAULT_MODEL || 'google/gemma-3-27b-it:free';
  const openRouterAppTitle = process.env.OPENROUTER_APP_TITLE || 'Nexus AI Gateway';

  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const ollamaDefaultModel = process.env.OLLAMA_DEFAULT_MODEL || 'llama3.1';

  const providerPriorityStr = process.env.AI_PROVIDER_PRIORITY || 'openrouter,ollama';
  const providerPriority = providerPriorityStr.split(',').map((s) => s.trim());

  const catalogPollIntervalMs = parseInt(process.env.MODEL_CATALOG_POLL_INTERVAL_MS || '300000', 10);

  // ── Instantiate Providers ──────────────────────────────────────────
  const providers = new Map<string, BaseAIProvider>();
  const providerList: BaseAIProvider[] = [];

  // OpenRouter Provider
  if (openRouterApiKey && openRouterApiKey !== 'your_openrouter_api_key_here') {
    const openRouterProvider = new OpenRouterProvider(
      openRouterApiKey,
      openRouterDefaultModel,
      openRouterAppTitle,
    );
    providers.set('openrouter', openRouterProvider);
    providerList.push(openRouterProvider);
    console.log('[Nexus] OpenRouter provider configured.');
  } else {
    console.warn('[Nexus] Warning: OPENROUTER_API_KEY not configured. OpenRouter provider disabled.');
  }

  // Ollama Provider
  const ollamaProvider = new OllamaProvider(ollamaHost, ollamaDefaultModel);
  providers.set('ollama', ollamaProvider);
  providerList.push(ollamaProvider);
  console.log(`[Nexus] Ollama provider configured at ${ollamaHost}.`);

  if (providers.size === 0) {
    console.error('[Nexus] Critical Error: No AI providers configured. Cannot start.');
    process.exit(1);
  }

  // ── Initialize Providers (health checks) ───────────────────────────
  console.log('[Nexus] Initializing providers...');
  for (const [name, provider] of providers) {
    try {
      await provider.initialize();
      console.log(`[Nexus] Provider "${name}" initialized. Available: ${provider.isAvailable}`);
    } catch (err) {
      console.warn(`[Nexus] Provider "${name}" initialization failed:`, err instanceof Error ? err.message : err);
    }
  }

  // ── Model Registry ─────────────────────────────────────────────────
  const registry = new ModelRegistry(providerList, catalogPollIntervalMs);
  await registry.start();
  console.log(`[Nexus] Model registry started. ${registry.getModelCount()} models cataloged.`);

  // ── Routing Engine ─────────────────────────────────────────────────
  const router = new ModelRouter(providers, registry, providerPriority);

  // Initial credit balance fetch
  try {
    const credits = await router.refreshCredits();
    if (credits) {
      console.log(`[Nexus] OpenRouter credits: $${credits.remaining.toFixed(4)} remaining.`);
    }
  } catch (err) {
    console.warn('[Nexus] Could not fetch initial credit balance:', err instanceof Error ? err.message : err);
  }

  // ── Usage Tracker ──────────────────────────────────────────────────
  const usageTracker = new UsageTracker();

  // ── HTTP Server ────────────────────────────────────────────────────
  const server = new NexusServer(router, registry, usageTracker, port, host);
  await server.start();

  // ── Graceful Shutdown ──────────────────────────────────────────────
  const handleShutdown = async (): Promise<void> => {
    console.log('\n[Nexus] Shutdown signal received. Stopping services...');
    try {
      await server.stop();
      registry.stop();
      for (const [name, provider] of providers) {
        try {
          await provider.dispose();
          console.log(`[Nexus] Provider "${name}" disposed.`);
        } catch (err) {
          console.warn(`[Nexus] Error disposing provider "${name}":`, err instanceof Error ? err.message : err);
        }
      }
      console.log('[Nexus] Clean exit complete.');
      process.exit(0);
    } catch (err) {
      console.error('[Nexus] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

main().catch((err) => {
  console.error('[Nexus] Fatal unhandled exception:', err);
  process.exit(1);
});
