import type { FastifyInstance, FastifyReply } from 'fastify';
import { createAuthHook, requestActor } from '../auth.js';
import type { TokenDirectory } from '../auth.js';
import type { Database } from '../db/client.js';
import {
  createComment,
  createIssue,
  getIssue,
  InvalidCursorError,
  ISSUE_STATUSES,
  listComments,
  listIssueEvents,
  listIssues,
  MAX_PAGE_SIZE,
  MAX_PRIORITY,
  MIN_PRIORITY,
  updateIssue,
} from './service.js';
import type { CreateCommentInput, CreateIssueInput, UpdateIssueInput } from './service.js';

const createIssueBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    body: { type: 'string' },
    status: { type: 'string', enum: ISSUE_STATUSES },
    priority: { type: 'integer', minimum: MIN_PRIORITY, maximum: MAX_PRIORITY },
    assignee: { type: ['string', 'null'] },
  },
};

const updateIssueBodySchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    body: { type: 'string' },
    status: { type: 'string', enum: ISSUE_STATUSES },
    priority: { type: 'integer', minimum: MIN_PRIORITY, maximum: MAX_PRIORITY },
    assignee: { type: ['string', 'null'] },
  },
};

const createCommentBodySchema = {
  type: 'object',
  required: ['body'],
  additionalProperties: false,
  properties: {
    body: { type: 'string', minLength: 1 },
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

export function registerIssueRoutes(
  app: FastifyInstance,
  db: Database,
  tokens: TokenDirectory,
): void {
  const authenticate = createAuthHook(tokens);

  app.post<{ Body: CreateIssueInput }>(
    '/issues',
    { schema: { body: createIssueBodySchema }, onRequest: authenticate },
    async (request, reply) => {
      const issue = await createIssue(db, requestActor(request), request.body);
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

  app.patch<{ Params: IssueParams; Body: UpdateIssueInput }>(
    '/issues/:id',
    { schema: { params: issueParamsSchema, body: updateIssueBodySchema }, onRequest: authenticate },
    async (request, reply) => {
      if (Object.keys(request.body).length === 0) {
        return reply.code(400).send(badRequest('at least one issue field must be provided'));
      }

      const issue = await updateIssue(db, requestActor(request), request.params.id, request.body);

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

  app.post<{ Params: IssueParams; Body: CreateCommentInput }>(
    '/issues/:id/comments',
    {
      schema: { params: issueParamsSchema, body: createCommentBodySchema },
      onRequest: authenticate,
    },
    async (request, reply) => {
      const comment = await createComment(
        db,
        requestActor(request),
        request.params.id,
        request.body,
      );

      if (comment === null) {
        return issueNotFound(reply);
      }

      return reply.code(201).send(comment);
    },
  );

  app.get<{ Params: IssueParams }>(
    '/issues/:id/comments',
    { schema: { params: issueParamsSchema } },
    async (request, reply) => {
      const comments = await listComments(db, request.params.id);

      if (comments === null) {
        return issueNotFound(reply);
      }

      return reply.send({ comments });
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
