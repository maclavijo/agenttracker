import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

export interface AppDependencies {
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

  return app;
}
