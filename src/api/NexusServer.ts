/**
 * @module NexusServer
 *
 * The primary HTTP server for the Nexus AI Gateway.
 *
 * {@link NexusServer} wraps an Express application that exposes both
 * OpenAI-compatible endpoints (`/v1/*`) and Nexus-specific management
 * endpoints (`/api/*`).  It delegates routing decisions to a
 * {@link ModelRouter}, model discovery to a {@link ModelRegistry},
 * and usage accounting to a {@link UsageTracker}.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import crypto from 'crypto';

import {
  requestLogger,
  requestIdMiddleware,
  corsConfig,
  errorHandler,
} from './middleware';
import { ModelRouter } from '../core/routing/ModelRouter';
import { ModelRegistry } from '../core/routing/ModelRegistry';
import { UsageTracker } from '../core/tracking/UsageTracker';
import {
  ChatMessage,
  CompletionOptions,
  UsageRecord,
} from '../core/providers/types';

/* ------------------------------------------------------------------ */
/*  NexusServer                                                        */
/* ------------------------------------------------------------------ */

/**
 * Express-based HTTP server that serves as the public API surface
 * of the Nexus AI Gateway.
 *
 * The server exposes:
 * - **POST /v1/chat/completions** – OpenAI-compatible chat completion.
 * - **GET  /v1/models**           – OpenAI-compatible model listing.
 * - **GET  /api/status**          – Provider health / uptime.
 * - **GET  /api/models**          – Full enriched model catalog.
 * - **GET  /api/usage**           – Aggregated usage snapshot.
 * - **GET  /api/credits**         – Current credit balance.
 * - **GET  /api/config**          – Read-only gateway configuration.
 */
export class NexusServer {
  /* ----- private readonly backing fields ----- */

  /** The Express application instance. */
  private readonly _app: express.Application;

  /** The underlying HTTP server (populated after {@link start}). */
  private _server: http.Server | null;

  /** Router responsible for provider selection and completion. */
  private readonly _modelRouter: ModelRouter;

  /** Registry of all known models across providers. */
  private readonly _modelRegistry: ModelRegistry;

  /** Tracker for per-request usage accounting. */
  private readonly _usageTracker: UsageTracker;

  /** TCP port to listen on. */
  private readonly _port: number;

  /** Network interface / host to bind to. */
  private readonly _host: string;

  /** Timestamp (ms since epoch) when the server instance was created. */
  private readonly _startedAt: number;

  /* ----- public getters ----- */

  /** The Express application instance. */
  public get app(): express.Application {
    return this._app;
  }

  /** The underlying HTTP server, or `null` if not yet started. */
  public get server(): http.Server | null {
    return this._server;
  }

  /** Router responsible for provider selection and completion. */
  public get modelRouter(): ModelRouter {
    return this._modelRouter;
  }

  /** Registry of all known models across providers. */
  public get modelRegistry(): ModelRegistry {
    return this._modelRegistry;
  }

  /** Tracker for per-request usage accounting. */
  public get usageTracker(): UsageTracker {
    return this._usageTracker;
  }

  /** TCP port the server listens on. */
  public get port(): number {
    return this._port;
  }

  /** Network interface the server is bound to. */
  public get host(): string {
    return this._host;
  }

  /* ----- constructor ----- */

  /**
   * Creates a new {@link NexusServer}.
   *
   * @param modelRouter   - Router used to select a provider and execute completions.
   * @param modelRegistry - Registry providing the unified model catalog.
   * @param usageTracker  - Tracker for recording per-request usage data.
   * @param port          - TCP port to listen on (default `3060`).
   * @param host          - Network interface to bind to (default `0.0.0.0`).
   *
   * @throws {Error} If `modelRouter` is falsy.
   * @throws {Error} If `modelRegistry` is falsy.
   * @throws {Error} If `usageTracker` is falsy.
   * @throws {Error} If `port` is not a positive integer.
   */
  public constructor(
    modelRouter: ModelRouter,
    modelRegistry: ModelRegistry,
    usageTracker: UsageTracker,
    port: number = 3060,
    host: string = '0.0.0.0',
  ) {
    if (!modelRouter) {
      throw new Error('NexusServer requires a valid ModelRouter instance.');
    }
    if (!modelRegistry) {
      throw new Error('NexusServer requires a valid ModelRegistry instance.');
    }
    if (!usageTracker) {
      throw new Error('NexusServer requires a valid UsageTracker instance.');
    }
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`NexusServer port must be a positive integer, received: ${port}`);
    }

    this._modelRouter = modelRouter;
    this._modelRegistry = modelRegistry;
    this._usageTracker = usageTracker;
    this._port = port;
    this._host = host;
    this._server = null;
    this._startedAt = Date.now();

    /* -- Bootstrap Express ----------------------------------------- */
    this._app = express();

    // Global middleware — order matters.
    this._app.use(express.json({ limit: '10mb' }));
    this._app.use(cors(corsConfig as any));
    this._app.use(requestIdMiddleware);
    this._app.use(requestLogger);

    // Register routes.
    this.registerRoutes();

    // Error handler must be last.
    this._app.use(errorHandler);
  }

  /* ----- route registration ----- */

  /**
   * Registers all HTTP routes on the Express application.
   */
  private registerRoutes(): void {
    this._app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));
    this._app.get('/v1/models', this.handleListModelsOpenAI.bind(this));
    this._app.get('/api/status', this.handleStatus.bind(this));
    this._app.get('/api/models', this.handleListModels.bind(this));
    this._app.get('/api/usage', this.handleUsage.bind(this));
    this._app.get('/api/credits', this.handleCredits.bind(this));
    this._app.get('/api/config', this.handleConfig.bind(this));
  }

  /* ----- route handlers ----- */

  /**
   * **POST /v1/chat/completions**
   *
   * OpenAI-compatible chat completion endpoint.  Accepts messages and
   * optional model / sampling parameters, routes the request through
   * {@link ModelRouter}, records usage, and returns a response in the
   * standard OpenAI chat-completion format with additional Nexus metadata.
   *
   * @param req  - Express request.
   * @param res  - Express response.
   * @param next - Express next function.
   */
  private async handleChatCompletion(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const {
        model,
        messages,
        temperature,
        max_tokens,
        top_p,
        stop,
        stream,
      } = req.body as {
        model?: string;
        messages: ChatMessage[];
        temperature?: number;
        max_tokens?: number;
        top_p?: number;
        stop?: string | string[];
        stream?: boolean;
      };

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          error: {
            message: 'messages is required and must be a non-empty array.',
            code: 400,
          },
        });
        return;
      }

      /* --- Build CompletionOptions -------------------------------- */
      const options: CompletionOptions = {};

      if (model !== undefined) {
        options.model = model;
      }
      if (temperature !== undefined) {
        options.temperature = temperature;
      }
      if (max_tokens !== undefined) {
        options.maxTokens = max_tokens;
      }
      if (top_p !== undefined) {
        options.topP = top_p;
      }
      if (stop !== undefined) {
        options.stop = Array.isArray(stop) ? stop : [stop];
      }
      if (stream !== undefined) {
        options.stream = stream;
      }

      /* --- Nexus custom headers (logged for tracing) -------------- */
      const nexusTaskHeader: string | undefined =
        req.headers['x-nexus-task'] as string | undefined;
      const preferProviderHeader: string | undefined =
        req.headers['x-nexus-prefer-provider'] as string | undefined;

      if (nexusTaskHeader || preferProviderHeader) {
        console.log(
          `[Nexus] Custom headers — task: ${nexusTaskHeader ?? 'auto'}, provider: ${preferProviderHeader ?? 'auto'}`,
        );
      }

      /* --- Execute completion ------------------------------------- */
      const result = await this._modelRouter.complete(messages, options);

      /* --- Record usage ------------------------------------------- */
      const usageRecord: UsageRecord = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        provider: result.provider,
        model: result.model,
        taskCategory: result.taskCategory,
        usage: result.usage,
        latencyMs: result.latencyMs,
        cost: result.cost,
        routingDecision: result.routingDecision,
      };

      this._usageTracker.record(usageRecord);

      /* --- Build OpenAI-compatible response ----------------------- */
      const responseBody = {
        id: `nexus-${crypto.randomUUID()}`,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant' as const,
              content: result.content,
            },
            finish_reason: 'stop' as const,
          },
        ],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
        x_nexus: {
          provider: result.provider,
          task_category: result.taskCategory,
          routing_decision: result.routingDecision,
          latency_ms: result.latencyMs,
        },
      };

      res.status(200).json(responseBody);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const statusCode: number = (err as any).statusCode || 500;

      console.error(`[Nexus] Chat completion error: ${err.message}`);

      res.status(statusCode).json({
        error: {
          message: err.message,
          code: statusCode,
        },
      });
    }
  }

  /**
   * **GET /v1/models**
   *
   * Returns the unified model catalog in the OpenAI-compatible
   * list format.
   *
   * @param _req - Express request (unused).
   * @param res  - Express response.
   */
  private async handleListModelsOpenAI(
    _req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const models = this._modelRegistry.getAllModels();

      const data = models.map((m: any) => ({
        id: m.id,
        object: 'model' as const,
        created: 0,
        owned_by: m.provider,
      }));

      res.status(200).json({ object: 'list', data });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Nexus] List models (OpenAI) error: ${err.message}`);
      res.status(500).json({ error: { message: err.message, code: 500 } });
    }
  }

  /**
   * **GET /api/status**
   *
   * Returns health / readiness information for every registered
   * provider, along with the server's current uptime in seconds.
   *
   * @param _req - Express request (unused).
   * @param res  - Express response.
   */
  private async handleStatus(
    _req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const providerStatus = await this._modelRouter.getProviderStatus();
      const uptimeSeconds: number = Math.floor(
        (Date.now() - this._startedAt) / 1000,
      );

      res.status(200).json({
        status: 'ok',
        uptime_seconds: uptimeSeconds,
        providers: providerStatus,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Nexus] Status error: ${err.message}`);
      res.status(500).json({ error: { message: err.message, code: 500 } });
    }
  }

  /**
   * **GET /api/models**
   *
   * Returns the full, enriched model catalog (raw `ModelInfo[]`)
   * from the registry.
   *
   * @param _req - Express request (unused).
   * @param res  - Express response.
   */
  private async handleListModels(
    _req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const models = this._modelRegistry.getAllModels();
      res.status(200).json({ models });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Nexus] List models error: ${err.message}`);
      res.status(500).json({ error: { message: err.message, code: 500 } });
    }
  }

  /**
   * **GET /api/usage**
   *
   * Returns an aggregated usage snapshot from the {@link UsageTracker}.
   *
   * @param _req - Express request (unused).
   * @param res  - Express response.
   */
  private async handleUsage(
    _req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const snapshot = this._usageTracker.getSnapshot();
      res.status(200).json(snapshot);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Nexus] Usage error: ${err.message}`);
      res.status(500).json({ error: { message: err.message, code: 500 } });
    }
  }

  /**
   * **GET /api/credits**
   *
   * Refreshes and returns the current credit balance from the
   * underlying providers.  Returns an error object if credit
   * information is unavailable.
   *
   * @param _req - Express request (unused).
   * @param res  - Express response.
   */
  private async handleCredits(
    _req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const credits = await this._modelRouter.refreshCredits();

      if (credits === null || credits === undefined) {
        res.status(200).json({ error: 'Credits not available' });
        return;
      }

      res.status(200).json({ credits });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Nexus] Credits error: ${err.message}`);
      res.status(500).json({ error: { message: err.message, code: 500 } });
    }
  }

  /**
   * **GET /api/config**
   *
   * Returns read-only configuration metadata about the running
   * gateway instance.
   *
   * @param _req - Express request (unused).
   * @param res  - Express response.
   */
  private async handleConfig(
    _req: Request,
    res: Response,
  ): Promise<void> {
    try {
      res.status(200).json({
        port: this._port,
        host: this._host,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Nexus] Config error: ${err.message}`);
      res.status(500).json({ error: { message: err.message, code: 500 } });
    }
  }

  /* ----- lifecycle methods ----- */

  /**
   * Starts the HTTP server, binding to the configured port and host.
   *
   * Logs a startup banner to the console indicating the address,
   * port, and available endpoint groups.
   *
   * @returns A promise that resolves once the server is listening.
   */
  public async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._server = http.createServer(this._app);

      this._server.listen(this._port, this._host, () => {
        const banner: string = [
          '',
          '╔══════════════════════════════════════════════════╗',
          '║              ⚡  NEXUS AI GATEWAY  ⚡             ║',
          '╠══════════════════════════════════════════════════╣',
          `║  Status  : Running                               ║`,
          `║  Address : http://${this._host}:${this._port}`.padEnd(52) + '║',
          '╠══════════════════════════════════════════════════╣',
          '║  Endpoints:                                      ║',
          '║    POST /v1/chat/completions  — Chat completion   ║',
          '║    GET  /v1/models            — Model list (OAI)  ║',
          '║    GET  /api/status           — Health status     ║',
          '║    GET  /api/models           — Full model catalog║',
          '║    GET  /api/usage            — Usage stats       ║',
          '║    GET  /api/credits          — Credit balance    ║',
          '║    GET  /api/config           — Configuration     ║',
          '╚══════════════════════════════════════════════════╝',
          '',
        ].join('\n');

        console.log(banner);
        resolve();
      });
    });
  }

  /**
   * Gracefully stops the HTTP server.
   *
   * @returns A promise that resolves once the server has closed all
   *          connections, or resolves immediately if the server was
   *          never started.
   */
  public async stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._server) {
        resolve();
        return;
      }

      this._server.close((err?: Error) => {
        if (err) {
          console.error(`[Nexus] Error stopping server: ${err.message}`);
          reject(err);
          return;
        }

        console.log('[Nexus] Server stopped.');
        this._server = null;
        resolve();
      });
    });
  }
}
