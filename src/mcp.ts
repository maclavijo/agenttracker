import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AuthConfigError, parseTokenDirectory } from './auth.js';
import type { TokenDirectory } from './auth.js';
import { databaseUrl } from './config.js';
import { createDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import type { Actor } from './events.js';
import {
  createComment,
  createIssue,
  getIssue,
  InvalidCursorError,
  ISSUE_STATUSES,
  listIssues,
  MAX_PAGE_SIZE,
  MAX_PRIORITY,
  MIN_PRIORITY,
  updateIssue,
} from './issues/service.js';
import type { IssueStatus } from './issues/service.js';

const SERVER_NAME = 'agenttracker';
const SERVER_VERSION = '0.1.0';

/** An error that is reported to the MCP client as a failed tool result. */
class ToolError extends Error {
  constructor(
    readonly statusCode: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A successful tool result: the JSON encoding of the service-layer value. */
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * A failed tool result. The payload mirrors the HTTP API error body so an agent
 * sees the same `statusCode`/`error`/`message` shape on both transports.
 */
function errorResult(error: ToolError): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          statusCode: error.statusCode,
          error: error.error,
          message: error.message,
        }),
      },
    ],
  };
}

/**
 * Runs one tool call and turns every failure into a failed MCP tool result.
 * Service errors keep their HTTP-equivalent status; unexpected failures are
 * logged on stderr (stdout carries the protocol) and reported as a 500.
 */
async function runTool(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await action());
  } catch (error) {
    if (error instanceof ToolError) {
      return errorResult(error);
    }

    if (error instanceof InvalidCursorError) {
      return errorResult(new ToolError(400, 'Bad Request', error.message));
    }

    if (error instanceof RangeError) {
      return errorResult(new ToolError(400, 'Bad Request', error.message));
    }

    console.error('MCP tool call failed:', error);
    return errorResult(
      new ToolError(500, 'Internal Server Error', 'The tool call could not be completed'),
    );
  }
}

/**
 * Resolves the actor for a tool call from `AGENT_TOKEN`.
 *
 * The token is a secret from the same token directory the HTTP server reads
 * (`AGENT_TOKENS`/`HUMAN_TOKENS`). A missing or unknown value fails the call
 * with a 401 instead of running unauthenticated.
 */
function requireActor(directory: TokenDirectory, token: string | undefined): Actor {
  if (token === undefined || token === '') {
    throw new ToolError(401, 'Unauthorized', 'AGENT_TOKEN is not configured');
  }

  const identity = directory.get(token);

  if (identity === undefined) {
    throw new ToolError(401, 'Unauthorized', 'AGENT_TOKEN is not a known token');
  }

  return { type: identity.actorType, id: identity.actorId };
}

function createIssueInput(args: {
  readonly title: string;
  readonly body?: string | undefined;
  readonly status?: IssueStatus | undefined;
  readonly priority?: number | undefined;
  readonly assignee?: string | null | undefined;
}): {
  title: string;
  body?: string;
  status?: IssueStatus;
  priority?: number;
  assignee?: string | null;
} {
  const input: {
    title: string;
    body?: string;
    status?: IssueStatus;
    priority?: number;
    assignee?: string | null;
  } = { title: args.title };

  if (args.body !== undefined) {
    input.body = args.body;
  }

  if (args.status !== undefined) {
    input.status = args.status;
  }

  if (args.priority !== undefined) {
    input.priority = args.priority;
  }

  if (args.assignee !== undefined) {
    input.assignee = args.assignee;
  }

  return input;
}

const statusSchema = z.enum(ISSUE_STATUSES);
const prioritySchema = z.number().int().min(MIN_PRIORITY).max(MAX_PRIORITY);
const issueIdSchema = z.string().min(1);

export function registerTools(
  server: McpServer,
  db: Database,
  directory: TokenDirectory,
  agentToken: string | undefined,
): void {
  server.registerTool(
    'issue_create',
    {
      title: 'Create issue',
      description:
        'Create an issue in the tracker. The write is attributed to the actor behind AGENT_TOKEN.',
      inputSchema: z.object({
        title: z.string().min(1).describe('Issue title'),
        body: z.string().optional().describe('Issue body'),
        status: statusSchema.optional().describe('Issue status'),
        priority: prioritySchema.optional().describe('Priority from 0 (none) to 4 (urgent)'),
        assignee: z
          .string()
          .nullable()
          .optional()
          .describe('Assignee id, or null for no assignee'),
      }),
    },
    async (args) =>
      runTool(async () => {
        const actor = requireActor(directory, agentToken);
        return createIssue(db, actor, createIssueInput(args));
      }),
  );

  server.registerTool(
    'issue_get',
    {
      title: 'Get issue',
      description: 'Fetch one issue by id.',
      inputSchema: z.object({ id: issueIdSchema.describe('Issue id') }),
    },
    async (args) =>
      runTool(async () => {
        requireActor(directory, agentToken);

        const issue = await getIssue(db, args.id);

        if (issue === null) {
          throw new ToolError(404, 'Not Found', 'Issue not found');
        }

        return issue;
      }),
  );

  server.registerTool(
    'issue_list',
    {
      title: 'List issues',
      description: 'List issues newest first, with opaque cursor pagination.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe('Page size, 1 to 100 (default 50)'),
        cursor: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('The nextCursor value from a previous page'),
      }),
    },
    async (args) =>
      runTool(async () => {
        requireActor(directory, agentToken);

        const options: { limit?: number; cursor?: string } = {};

        if (args.limit !== undefined) {
          options.limit = args.limit;
        }

        if (args.cursor !== undefined) {
          options.cursor = args.cursor;
        }

        return listIssues(db, options);
      }),
  );

  server.registerTool(
    'issue_update',
    {
      title: 'Update issue',
      description:
        'Update one or more fields on an issue. Only the supplied fields change. The write is attributed to the actor behind AGENT_TOKEN.',
      inputSchema: z.object({
        id: issueIdSchema.describe('Issue id'),
        title: z.string().min(1).optional().describe('New title'),
        body: z.string().optional().describe('New body'),
        status: statusSchema.optional().describe('New status'),
        priority: prioritySchema.optional().describe('New priority from 0 to 4'),
        assignee: z
          .string()
          .nullable()
          .optional()
          .describe('New assignee id, or null to clear it'),
      }),
    },
    async (args) =>
      runTool(async () => {
        const actor = requireActor(directory, agentToken);
        const changes: {
          title?: string;
          body?: string;
          status?: IssueStatus;
          priority?: number;
          assignee?: string | null;
        } = {};

        if (args.title !== undefined) {
          changes.title = args.title;
        }

        if (args.body !== undefined) {
          changes.body = args.body;
        }

        if (args.status !== undefined) {
          changes.status = args.status;
        }

        if (args.priority !== undefined) {
          changes.priority = args.priority;
        }

        if (args.assignee !== undefined) {
          changes.assignee = args.assignee;
        }

        if (Object.keys(changes).length === 0) {
          throw new ToolError(400, 'Bad Request', 'at least one issue field must be provided');
        }

        const issue = await updateIssue(db, actor, args.id, changes);

        if (issue === null) {
          throw new ToolError(404, 'Not Found', 'Issue not found');
        }

        return issue;
      }),
  );

  server.registerTool(
    'comment_add',
    {
      title: 'Add comment',
      description:
        'Append a comment to an issue. The comment is attributed to the actor behind AGENT_TOKEN.',
      inputSchema: z.object({
        issueId: issueIdSchema.describe('Issue id to comment on'),
        body: z.string().min(1).describe('Comment body'),
      }),
    },
    async (args) =>
      runTool(async () => {
        const actor = requireActor(directory, agentToken);
        const comment = await createComment(db, actor, args.issueId, { body: args.body });

        if (comment === null) {
          throw new ToolError(404, 'Not Found', 'Issue not found');
        }

        return comment;
      }),
  );
}

async function main(): Promise<void> {
  const env = process.env;
  const directory = parseTokenDirectory(env);
  const database = createDatabase(databaseUrl(env));
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  if (env.AGENT_TOKEN === undefined || env.AGENT_TOKEN === '') {
    console.error(
      'AGENT_TOKEN is not configured; MCP tool calls will fail with a 401 until it is set.',
    );
  }

  registerTools(server, database.db, directory, env.AGENT_TOKEN);

  let shutdownPromise: Promise<void> | undefined;

  function shutdown(signal?: string): Promise<void> {
    shutdownPromise ??= (async () => {
      console.error(
        signal === undefined ? 'MCP server closing.' : `MCP server shutting down (${signal}).`,
      );

      try {
        await server.close();
      } catch (error) {
        console.error('Error while closing the MCP server:', error);
      } finally {
        await database.close();
      }
    })();

    return shutdownPromise;
  }

  server.server.onclose = () => {
    void shutdown();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await shutdown();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof AuthConfigError) {
    console.error(error.message);
  } else {
    console.error('Failed to start the MCP server:', error);
  }

  process.exitCode = 1;
}
