import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db/client.js';
import type { Actor } from '../events.js';
import {
  createIssue,
  getIssue,
  InvalidCursorError,
  ISSUE_STATUSES,
  listIssueEvents,
  listIssues,
  MAX_PAGE_SIZE,
  MAX_PRIORITY,
  MIN_PRIORITY,
} from './service.js';
import type { CreateIssueInput } from './service.js';

// T2 has no authentication yet (T3 adds bearer tokens); attribute writes to the
// deployment's API actor until the token identity replaces this.
const HTTP_ACTOR: Actor = { type: 'agent', id: 'api' };

const createIssueBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    body: { type: 'string' },
    status: { type: 'string', enum: ISSUE_STATUSES },
    priority: { type: 'integer', minimum: MIN_PRIORITY, maximum: MAX_PRIORITY },
    assignee: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

const listIssuesQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
    cursor: { type: 'string', minLength: 1, maxLength: 64 },
  },
};

const issueParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
};

interface IssueParams {
  id: string;
}

interface ListIssuesQuery {
  limit?: number;
  cursor?: string;
}

export function registerIssueRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: CreateIssueInput }>(
    '/issues',
    { schema: { body: createIssueBodySchema } },
    async (request, reply) => {
      const issue = await createIssue(db, HTTP_ACTOR, request.body);
      return reply.code(201).send(issue);
    },
  );

  app.get<{ Querystring: ListIssuesQuery }>(
    '/issues',
    { schema: { querystring: listIssuesQuerySchema } },
    async (request, reply) => {
      try {
        return reply.send(await listIssues(db, request.query));
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }
    },
  );

  app.get<{ Params: IssueParams }>(
    '/issues/:id',
    { schema: { params: issueParamsSchema } },
    async (request, reply) => {
      const issue = await getIssue(db, request.params.id);

      if (issue === null) {
        return issueNotFound(reply);
      }

      return reply.send(issue);
    },
  );

  app.get<{ Params: IssueParams }>(
    '/issues/:id/events',
    { schema: { params: issueParamsSchema } },
    async (request, reply) => {
      const timeline = await listIssueEvents(db, request.params.id);

      if (timeline === null) {
        return issueNotFound(reply);
      }

      return reply.send({ events: timeline });
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

function badRequest(message: string): Record<string, unknown> {
  return { statusCode: 400, error: 'Bad Request', message };
}
