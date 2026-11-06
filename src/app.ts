import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Database } from './db/client.js';
import { registerIssueRoutes } from './issues/routes.js';

export interface AppDependencies {
  db: Database;
  ping(): Promise<void>;
}

export function buildApp(
  dependencies: AppDependencies,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);

  app.get('/health', async (_request, reply) => {
    try {
      await dependencies.ping();
      return { ok: true, db: 'up' };
    } catch (error) {
      app.log.warn({ err: error }, 'database health check failed');
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });

  registerIssueRoutes(app, dependencies.db);

  return app;
}
