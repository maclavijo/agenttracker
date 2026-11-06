import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ActorIdentity } from '../auth.js';
import type { Database } from '../db/client.js';
import { createComment } from '../issues/service.js';
import type { CreateCommentInput } from '../issues/service.js';
import { renderPage } from './page.js';

export interface WebUiOptions {
  /** The human the browser posts as, or null when commenting is disabled. */
  readonly humanActor: ActorIdentity | null;
}

const issueParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
};

const commentBodySchema = {
  type: 'object',
  required: ['body'],
  additionalProperties: false,
  properties: {
    body: { type: 'string', minLength: 1 },
  },
};

interface IssueParams {
  id: string;
}

/**
 * Registers the plain V1 web UI.
 *
 * `GET /` serves the one self-contained page. `POST /ui/issues/:id/comments`
 * is the only write the page performs: it is a thin proxy that authenticates
 * with the server-side `WEB_UI_HUMAN_TOKEN` actor so the bearer token never
 * reaches the browser. Both write through the same service layer as the HTTP
 * API and MCP server, keeping the event log as the single write path.
 */
export function registerWebRoutes(
  app: FastifyInstance,
  db: Database,
  options: WebUiOptions,
): void {
  app.get('/', async (_request, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .send(renderPage({ commentsEnabled: options.humanActor !== null }));
  });

  app.post<{ Params: IssueParams; Body: CreateCommentInput }>(
    '/ui/issues/:id/comments',
    { schema: { params: issueParamsSchema, body: commentBodySchema } },
    async (request, reply) => {
      const human = options.humanActor;

      if (human === null) {
        return reply.code(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Commenting is not configured on this server',
        });
      }

      const comment = await createComment(
        db,
        { type: 'human', id: human.actorId },
        request.params.id,
        request.body,
      );

      if (comment === null) {
        return issueNotFound(reply);
      }

      return reply.code(201).send(comment);
    },
  );
}

function issueNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: 'Issue not found',
  });
}
