import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, ActorType } from './events.js';

/** The identity resolved from a bearer token. */
export interface ActorIdentity {
  readonly actorType: ActorType;
  readonly actorId: string;
}

/** Bearer token to actor identity. Keys are secrets and must never be logged. */
export type TokenDirectory = ReadonlyMap<string, ActorIdentity>;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/**
 * Reads the static bearer tokens from `AGENT_TOKENS` and `HUMAN_TOKENS`.
 *
 * Both variables hold a comma-separated list of `token:actorId` entries; the
 * first colon separates the secret from the actor id. Blank entries (for
 * example a trailing comma) are ignored. A malformed entry or the same token
 * configured twice is a startup error rather than a silently unusable config.
 */
export function parseTokenDirectory(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, ActorIdentity> {
  const directory = new Map<string, ActorIdentity>();

  addTokens(directory, 'AGENT_TOKENS', env.AGENT_TOKENS, 'agent');
  addTokens(directory, 'HUMAN_TOKENS', env.HUMAN_TOKENS, 'human');

  return directory;
}

function addTokens(
  directory: Map<string, ActorIdentity>,
  variable: string,
  raw: string | undefined,
  actorType: ActorType,
): void {
  if (raw === undefined) {
    return;
  }

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();

    if (trimmed === '') {
      continue;
    }

    const separator = trimmed.indexOf(':');

    if (separator <= 0) {
      // Never include the entry in the message: it contains the secret.
      throw new AuthConfigError(`${variable} entries must use the "token:actorId" format`);
    }

    const token = trimmed.slice(0, separator).trim();
    const actorId = trimmed.slice(separator + 1).trim();

    if (token === '' || actorId === '') {
      throw new AuthConfigError(`${variable} entries must have both a token and an actor id`);
    }

    if (directory.has(token)) {
      throw new AuthConfigError('The same bearer token is configured more than once');
    }

    directory.set(token, { actorType, actorId });
  }
}

/** Resolves an `Authorization` header, or null when it is missing or unknown. */
export function resolveActorIdentity(
  directory: TokenDirectory,
  authorization: string | undefined,
): ActorIdentity | null {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];

  if (token === undefined) {
    return null;
  }

  return directory.get(token) ?? null;
}

/**
 * Fastify request hook for routes that write. It resolves the token into
 * `request.actor` and rejects the request with a JSON 401 otherwise.
 */
export function createAuthHook(directory: TokenDirectory) {
  return async function authenticateRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const identity = resolveActorIdentity(directory, request.headers.authorization);

    if (identity === null) {
      await reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'A valid bearer token is required',
      });
      return;
    }

    request.actor = identity;
  };
}

/** The actor for an authenticated request. Only call this behind the auth hook. */
export function requestActor(request: FastifyRequest): Actor {
  const identity = request.actor;

  if (identity === null) {
    throw new Error('requestActor: the route is not protected by the bearer-token hook');
  }

  return { type: identity.actorType, id: identity.actorId };
}
