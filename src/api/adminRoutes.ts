/**
 * @module AdminRoutes
 *
 * Management endpoints for remote Nexus administration.
 * Eliminates the need for SSH access to manage the gateway.
 *
 * All admin routes are prefixed with `/api/admin/`.
 */

import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

/** Project root (where package.json lives). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Create the admin router.
 *
 * Provides self-management endpoints:
 * - `POST /api/admin/update`  — Pull latest from git, rebuild, restart via PM2.
 * - `POST /api/admin/restart` — Restart the PM2 process.
 * - `GET  /api/admin/logs`    — Recent PM2 log output.
 * - `GET  /api/admin/version` — Current git commit and branch info.
 */
export function createAdminRouter(): Router {
  const router = Router();

  /* ------------------------------------------------------------------ */
  /*  GET /api/admin/version                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Returns the current git commit, branch, and package version.
   */
  router.get('/version', async (_req: Request, res: Response) => {
    try {
      const [commitResult, branchResult] = await Promise.all([
        execAsync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT }),
        execAsync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_ROOT }),
      ]);

      const packageJson = JSON.parse(
        fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
      );

      res.status(200).json({
        version: packageJson.version,
        commit: commitResult.stdout.trim(),
        branch: branchResult.stdout.trim(),
        projectRoot: PROJECT_ROOT,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  POST /api/admin/update                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Self-update: git pull → npm ci → npm run build → pm2 restart.
   *
   * Returns the output of each step. The restart step will terminate
   * the current process, so the response is sent before restarting.
   */
  router.post('/update', async (_req: Request, res: Response) => {
    const steps: Array<{ step: string; output: string; success: boolean }> = [];

    try {
      // Step 1: git pull
      console.log('[Admin] Starting self-update...');
      const pullResult = await execAsync('git pull', { cwd: PROJECT_ROOT });
      steps.push({
        step: 'git pull',
        output: pullResult.stdout.trim(),
        success: true,
      });

      if (pullResult.stdout.includes('Already up to date')) {
        res.status(200).json({
          message: 'Already up to date.',
          steps,
          restarting: false,
        });
        return;
      }

      // Step 2: npm ci
      const installResult = await execAsync('npm ci', { cwd: PROJECT_ROOT });
      steps.push({
        step: 'npm ci',
        output: installResult.stdout.trim().split('\n').slice(-2).join('\n'),
        success: true,
      });

      // Step 3: npm run build
      const buildResult = await execAsync('npm run build', { cwd: PROJECT_ROOT });
      steps.push({
        step: 'npm run build',
        output: buildResult.stdout.trim() || 'Build succeeded.',
        success: true,
      });

      // Step 4: Respond first, then restart (restart kills this process)
      steps.push({
        step: 'pm2 restart',
        output: 'Restart scheduled.',
        success: true,
      });

      res.status(200).json({
        message: 'Update complete. Restarting...',
        steps,
        restarting: true,
      });

      // Schedule restart after response is sent
      setTimeout(async () => {
        try {
          await execAsync('pm2 restart nexus-gateway');
        } catch {
          // If PM2 isn't available, just exit and let the process manager restart us
          console.log('[Admin] PM2 restart failed, exiting for process manager...');
          process.exit(0);
        }
      }, 500);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ step: 'error', output: message, success: false });
      console.error(`[Admin] Update failed: ${message}`);
      res.status(500).json({ error: message, steps });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  POST /api/admin/restart                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Restart the Nexus process via PM2.
   */
  router.post('/restart', async (_req: Request, res: Response) => {
    try {
      res.status(200).json({ message: 'Restarting...' });

      setTimeout(async () => {
        try {
          await execAsync('pm2 restart nexus-gateway');
        } catch {
          process.exit(0);
        }
      }, 500);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  GET /api/admin/logs                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Returns recent PM2 log output for the nexus-gateway process.
   */
  router.get('/logs', async (req: Request, res: Response) => {
    try {
      const lines = parseInt(req.query.lines as string) || 50;
      const result = await execAsync(
        `pm2 logs nexus-gateway --lines ${lines} --nostream`,
        { cwd: PROJECT_ROOT, timeout: 5000 },
      );

      res.status(200).json({
        logs: result.stdout.trim(),
        errors: result.stderr.trim() || undefined,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
