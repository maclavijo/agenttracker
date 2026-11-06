import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { listIssueEvents } from '../src/issues/service.js';
import { AGENT_ACTOR_ID, AGENT_TOKEN, truncateAll } from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface IssueJson {
  id: string;
  key: number;
  title: string;
  body: string;
  status: string;
  priority: number;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
}

interface CommentJson {
  id: number;
  issueId: string;
  body: string;
  actorType: string;
  actorId: string;
  createdAt: string;
}

interface IssuePageJson {
  issues: IssueJson[];
  nextCursor: string | null;
}

interface ToolErrorJson {
  statusCode: number;
  error: string;
  message: string;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const database = createDatabase(databaseUrl());
let client: Client;

/**
 * Environment for a spawned MCP server. The parent token configuration is
 * replaced so a fixture token always maps to the fixture actor.
 */
function serverEnvironment(agentToken: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  delete env['AGENT_TOKEN'];
  delete env['AGENT_TOKENS'];
  delete env['HUMAN_TOKENS'];

  env['DATABASE_URL'] = databaseUrl();
  env['AGENT_TOKENS'] = `${AGENT_TOKEN}:${AGENT_ACTOR_ID}`;

  if (agentToken !== undefined) {
    env['AGENT_TOKEN'] = agentToken;
  }

  return env;
}

/** Spawns `src/mcp.ts` over stdio and performs the MCP initialize handshake. */
async function connectClient(agentToken: string | undefined): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: REPO_ROOT,
    env: serverEnvironment(agentToken),
    stderr: 'pipe',
  });
  const stderr = transport.stderr;

  if (stderr !== null) {
    // Drain stderr so a chatty server cannot block on a full pipe.
    stderr.on('data', () => undefined);
  }

  const connected = new Client({ name: 'agenttracker-mcp-test', version: '1.0.0' });
  await connected.connect(transport);
  return connected;
}

function parseJson<T>(result: ToolResult): T {
  const [block] = result.content;

  expect(block?.type).toBe('text');

  if (block?.text === undefined) {
    throw new Error('expected a text content block');
  }

  return JSON.parse(block.text) as T;
}

async function callTool(
  target: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await target.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(
  target: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await callTool(target, name, args);

  expect(result.isError).toBeUndefined();

  return parseJson<T>(result);
}

beforeAll(async () => {
  await truncateAll(database.db);
  client = await connectClient(AGENT_TOKEN);
});

beforeEach(async () => {
  await truncateAll(database.db);
});

afterAll(async () => {
  await client.close();
  await truncateAll(database.db);
  await database.close();
});

describe('MCP tools', () => {
  it('advertises the five tracker tools', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'comment_add',
      'issue_create',
      'issue_get',
      'issue_list',
      'issue_update',
    ]);

    const create = tools.find((tool) => tool.name === 'issue_create');

    expect(create?.inputSchema).toMatchObject({
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'done', 'canceled'],
        },
        priority: { type: 'integer', minimum: 0, maximum: 4 },
        assignee: { type: ['string', 'null'] },
      },
    });

    const list = tools.find((tool) => tool.name === 'issue_list');

    expect(list?.inputSchema).toMatchObject({
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1, maxLength: 64 },
      },
    });
  });

  it('does an issue_create -> issue_get -> comment_add roundtrip attributed to the token actor', async () => {
    const created = await callJson<IssueJson>(client, 'issue_create', {
      title: 'Created over MCP',
      body: 'Roundtrip body',
      status: 'todo',
      priority: 2,
      assignee: 'agent-7',
    });

    expect(created).toMatchObject({
      title: 'Created over MCP',
      body: 'Roundtrip body',
      status: 'todo',
      priority: 2,
      assignee: 'agent-7',
      lastEventSeq: 1,
    });

    const fetched = await callJson<IssueJson>(client, 'issue_get', { id: created.id });

    expect(fetched).toEqual(created);

    const comment = await callJson<CommentJson>(client, 'comment_add', {
      issueId: created.id,
      body: 'Verified over MCP',
    });

    expect(comment).toMatchObject({
      issueId: created.id,
      body: 'Verified over MCP',
      actorType: 'agent',
      actorId: AGENT_ACTOR_ID,
    });

    const events = await listIssueEvents(database.db, created.id);

    expect(events?.map((event) => event.type)).toEqual(['issue.created', 'comment.created']);
    expect(events?.every((event) => event.actorId === AGENT_ACTOR_ID)).toBe(true);
  });

  it('updates an issue and paginates the list through the same service layer', async () => {
    const first = await callJson<IssueJson>(client, 'issue_create', { title: 'First' });
    const second = await callJson<IssueJson>(client, 'issue_create', { title: 'Second' });

    const updated = await callJson<IssueJson>(client, 'issue_update', {
      id: first.id,
      title: 'First, renamed',
      status: 'done',
      assignee: null,
    });

    expect(updated).toMatchObject({
      id: first.id,
      title: 'First, renamed',
      status: 'done',
      assignee: null,
      lastEventSeq: 3,
    });

    const page = await callJson<IssuePageJson>(client, 'issue_list', { limit: 1 });

    expect(page.issues.map((issue) => issue.id)).toEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();

    if (page.nextCursor === null) {
      throw new Error('expected a next cursor for the first page');
    }

    const next = await callJson<IssuePageJson>(client, 'issue_list', {
      limit: 1,
      cursor: page.nextCursor,
    });

    expect(next.issues.map((issue) => issue.id)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
  });

  it('reports unknown issues, empty updates and invalid input as tool errors', async () => {
    const missing = await callTool(client, 'issue_get', { id: 'does-not-exist' });

    expect(missing.isError).toBe(true);
    expect(parseJson<ToolErrorJson>(missing)).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Issue not found',
    });

    const created = await callJson<IssueJson>(client, 'issue_create', { title: 'Empty update' });
    const emptyUpdate = await callTool(client, 'issue_update', { id: created.id });

    expect(emptyUpdate.isError).toBe(true);
    expect(parseJson<ToolErrorJson>(emptyUpdate)).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
    });

    const missingComment = await callTool(client, 'comment_add', {
      issueId: 'does-not-exist',
      body: 'Lost comment',
    });

    expect(missingComment.isError).toBe(true);
    expect(parseJson<ToolErrorJson>(missingComment).statusCode).toBe(404);

    const invalidCreate = await callTool(client, 'issue_create', { title: '' });

    expect(invalidCreate.isError).toBe(true);
  });
});

describe('AGENT_TOKEN authentication', () => {
  it('fails tool calls with a clear 401 when the token is missing or unknown', async () => {
    for (const agentToken of [undefined, 'not-a-configured-token']) {
      const isolated = await connectClient(agentToken);

      try {
        const result = await callTool(isolated, 'issue_list', {});

        expect(result.isError).toBe(true);

        const error = parseJson<ToolErrorJson>(result);

        expect(error.statusCode).toBe(401);
        expect(error.message).toContain('AGENT_TOKEN');
      } finally {
        await isolated.close();
      }
    }
  });
});
