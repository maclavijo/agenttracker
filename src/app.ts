import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { ActorIdentity, TokenDirectory } from './auth.js';
import type { Database } from './db/client.js';
import { registerIssueRoutes } from './issues/routes.js';
import type { EventStreamHub } from './stream/hub.js';
import { registerStreamRoutes } from './stream/routes.js';
import type { StreamRouteOptions } from './stream/routes.js';

export interface AppDependencies {
  db: Database;
  ping(): Promise<void>;
  /** Bearer tokens for write routes. Empty when omitted, so writes are rejected. */
  readonly tokens?: TokenDirectory;
  /**
   * Live event fan-out for `GET /stream`. The route is only registered when a
   * hub is supplied; its listener is opened with the app and closed with it.
   */
  readonly stream?: EventStreamHub;
  readonly streamOptions?: StreamRouteOptions;
}

export function buildApp(
  dependencies: AppDependencies,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);
  const tokens = dependencies.tokens ?? new Map<string, ActorIdentity>();

  app.decorateRequest('actor', null);

  app.get('/health', async (_request, reply) => {
    try {
      await dependencies.ping();
      return { ok: true, db: 'up' };
    } catch (error) {
      app.log.warn({ err: error }, 'database health check failed');
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });

  registerIssueRoutes(app, dependencies.db, tokens);

  const stream = dependencies.stream;

  if (stream !== undefined) {
    app.addHook('onReady', async () => {
      await stream.start();
    });

    app.addHook('onClose', async () => {
      await stream.close();
    });

    registerStreamRoutes(app, dependencies.db, stream, dependencies.streamOptions);
  }

  return app;
}
