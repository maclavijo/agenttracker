import type { ActorIdentity } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved by the bearer-token hook; null until an authenticated route runs it. */
    actor: ActorIdentity | null;
  }
}
