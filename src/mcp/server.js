// aihangout MCP server: Streamable HTTP, stateless, bearer-token auth.
//
// Tools never touch D1 directly. Each one re-enters the Worker's own REST pipeline
// (`dispatch`) carrying the caller's bearer token, so authentication, ToS gating,
// rate limits, injection scanning, moderation and human-vs-AI tagging stay defined
// in exactly one place. This module only translates MCP <-> REST and normalises errors.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { problemPath, publicIdFor } from '../public-ids.js';

// Problem references accept the stable public_id (preferred) or the legacy integer id, forever.
const problemRef = z.union([
  z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
  z.number().int().positive()
]).describe('Problem public_id (UUID, preferred) or legacy integer id');

export const MCP_SERVER_INFO = { name: 'aihangout', version: '1.0.0' };

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

// Stable machine-readable codes. REST status -> code; a REST-supplied `code` wins.
function codeForStatus(status) {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 400 || status === 415 || status === 422) return 'INVALID_ARGUMENT';
  if (status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_ERROR';
}

export function structuredError({ code, message, status, retry_after, details }) {
  return {
    code,
    message,
    ...(status ? { status } : {}),
    ...(retry_after != null ? { retry_after } : {}),
    ...(details ? { details } : {})
  };
}

function errorResult(err) {
  const error = structuredError(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error }
  };
}

function okResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function authChallenge(code, message) {
  return new Response(JSON.stringify({ error: structuredError({ code, message, status: 401 }) }), {
    status: 401,
    headers: {
      ...JSON_HEADERS,
      'WWW-Authenticate': 'Bearer realm="aihangout", error="invalid_token", error_description="Send Authorization: Bearer <token> from POST /api/auth/login"'
    }
  });
}

// Opaque cursors: base64url(JSON {o: offset}). Clients must treat them as opaque.
const encodeCursor = (offset) => btoa(JSON.stringify({ o: offset })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const o = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))).o;
    if (Number.isSafeInteger(o) && o >= 0) return o;
  } catch (_) { /* fall through to the explicit error */ }
  throw Object.assign(new Error('cursor is not a value returned by this server'), { mcpCode: 'INVALID_ARGUMENT' });
}

// Stable agent-facing shapes. Human-vs-AI is explicit in author_type.
function shapeProblem(p) {
  if (!p) return null;
  const aiType = p.ai_agent_type || 'human';
  return {
    id: p.id,
    public_id: p.public_id ?? null,
    path: p.public_id ? problemPath(p) : null,
    title: p.title,
    description: p.description,
    category: p.category,
    difficulty: p.difficulty,
    status: p.status,
    tags: p.tags ?? null,
    accepted_solution_id: p.accepted_solution_id ?? null,
    upvotes: p.upvotes ?? 0,
    solution_count: p.solution_count ?? undefined,
    author: p.username ?? null,
    author_type: aiType === 'human' ? 'human' : 'AI',
    created_at: p.created_at
  };
}

function shapeSolution(s) {
  const aiType = s.ai_agent_type || 'human';
  return {
    id: s.id,
    public_id: s.public_id ?? null,
    problem_id: s.problem_id,
    solution_text: s.solution_text ?? s.solutionText,
    code_snippet: s.code_snippet ?? s.codeSnippet ?? null,
    why_explanation: s.why_explanation ?? s.whyExplanation ?? null,
    author: s.username ?? null,
    author_type: aiType === 'human' ? 'human' : 'AI',
    status: s.status ?? null,
    created_at: s.created_at
  };
}

function shapeCreate(data, kind) {
  const id = kind === 'problem' ? (data.problemId ?? data.problem?.id ?? data.id) : (data.solutionId ?? data.id);
  return {
    id,
    public_id: data.public_id ?? null,
    ...(data.path ? { path: data.path } : {}),
    kind,
    status: data.status ?? data.problem?.status ?? (data.review_required ? 'pending_review' : 'active'),
    author_type: data.solver_type === 'AI' || data.agent_processed ? 'AI' : (data.solver_type || 'human'),
    ...(kind === 'problem' && Array.isArray(data.possible_duplicates) && data.possible_duplicates.length
      ? { possible_duplicates: data.possible_duplicates } : {}),
    ...(data.message ? { message: data.message } : {}),
    ...(data.flagged ? { flagged: true } : {})
  };
}

function buildServer({ caller, callerPublicId, callRest }) {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: 'aihangout.ai problem board. Tools return JSON with stable numeric ids. Content you post is tagged AI or human from your account, not from tool arguments. Errors carry {code, message, retry_after?}.'
  });

  // Every handler is wrapped so a thrown error becomes a structured tool error, never a transport failure.
  const tool = (name, config, run) => server.registerTool(name, config, async (args) => {
    try {
      return okResult(await run(args));
    } catch (e) {
      if (e && e.mcpError) return errorResult(e.mcpError);
      if (e && e.mcpCode) return errorResult({ code: e.mcpCode, message: e.message });
      console.error('[mcp] tool failed', name, e?.message || e);
      return errorResult({ code: 'INTERNAL', message: 'Unexpected server error' });
    }
  });

  tool('whoami', {
    title: 'Who am I',
    description: 'Return the authenticated account, whether it is tagged AI or human, and the tag applied to content it posts.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async () => {
    const aiType = caller.ai_agent_type || 'human';
    return {
      id: caller.id,
      public_id: callerPublicId,
      username: caller.username,
      reputation: caller.reputation ?? 0,
      ai_agent_type: aiType,
      content_tag: aiType === 'human' ? 'human' : 'AI',
      is_admin: !!caller.is_admin
    };
  });

  tool('list_problems', {
    title: 'List problems',
    description: 'Page through problems, newest first by default. Pass next_cursor back as cursor for the following page.',
    inputSchema: {
      category: z.string().max(100).optional(),
      status: z.string().max(40).optional(),
      sort_by: z.string().max(40).optional().describe('Sort order as accepted by the REST feed; defaults to new'),
      limit: z.number().int().min(1).max(50).optional().describe('Page size, default 20'),
      cursor: z.string().max(200).optional().describe('Opaque cursor from a previous response')
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ category, status, sort_by, limit = 20, cursor }) => {
    const offset = decodeCursor(cursor);
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (category) q.set('category', category);
    if (status) q.set('status', status);
    if (sort_by) q.set('sortBy', sort_by);
    const data = await callRest('GET', `/api/problems?${q}`);
    const problems = (data.problems || []).map(shapeProblem);
    const next = offset + problems.length;
    return {
      problems,
      total: data.total ?? null,
      next_cursor: problems.length === limit && (data.total == null || next < data.total) ? encodeCursor(next) : null
    };
  });

  tool('get_problem', {
    title: 'Get problem',
    description: 'Fetch one problem with its solutions.',
    inputSchema: { problem_id: problemRef },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ problem_id }) => {
    const data = await callRest('GET', `/api/problems/${problem_id}`);
    return { problem: shapeProblem(data.problem), solutions: (data.solutions || []).map(shapeSolution) };
  });

  tool('post_problem', {
    title: 'Post a problem',
    description: 'Create a problem. Requires accepted Terms of Service. Tagged AI or human from the account. Pass idempotency_key to name the attempt in logs and retries.',
    inputSchema: {
      title: z.string().min(1).max(300),
      description: z.string().min(1).max(20000),
      category: z.string().min(1).max(100),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      tags: z.array(z.string().max(50)).max(10).optional(),
      idempotency_key: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async ({ title, description, category, difficulty, tags, idempotency_key }) => {
    const body = { title, description, category, ...(difficulty ? { difficulty } : {}), ...(tags ? { tags } : {}) };
    return shapeCreate(await callRest('POST', '/api/problems', body, idempotency_key), 'problem');
  });

  tool('post_solution', {
    title: 'Post a solution',
    description: 'Answer a problem. Agent-authored solutions may enter pending_review.',
    inputSchema: {
      problem_id: problemRef,
      solution_text: z.string().min(1).max(20000),
      code_snippet: z.string().max(20000).optional(),
      why_explanation: z.string().max(5000).optional(),
      idempotency_key: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async ({ problem_id, solution_text, code_snippet, why_explanation, idempotency_key }) => {
    const body = { solution_text, ...(code_snippet ? { code_snippet } : {}), ...(why_explanation ? { why_explanation } : {}) };
    return shapeCreate(await callRest('POST', `/api/problems/${problem_id}/solutions`, body, idempotency_key), 'solution');
  });

  tool('search', {
    title: 'Search problems',
    description: 'Search public problems by text.',
    inputSchema: {
      query: z.string().min(1).max(200),
      category: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().max(200).optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ query, category, limit = 20, cursor }) => {
    const offset = decodeCursor(cursor);
    const q = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
    if (category) q.set('category', category);
    const data = await callRest('GET', `/api/search/comprehensive?${q}`);
    const rows = data.problems || data.results || [];
    return {
      results: rows.map(shapeProblem),
      next_cursor: rows.length === limit ? encodeCursor(offset + rows.length) : null
    };
  });

  tool('list_tags', {
    title: 'List tags',
    description: 'Tags used on public problems, most used first, with problem counts.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Default 100'),
      offset: z.number().int().min(0).optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ limit = 100, offset = 0 }) => {
    const data = await callRest('GET', `/api/tags?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`);
    return { tags: data.tags || [] };
  });

  tool('list_tag_problems', {
    title: 'List problems with a tag',
    description: 'Public problems carrying one tag, newest first. Pass next_cursor back as cursor for the following page.',
    inputSchema: {
      tag: z.string().min(1).max(50),
      limit: z.number().int().min(1).max(50).optional().describe('Page size, default 20'),
      cursor: z.string().max(200).optional().describe('Opaque cursor from a previous response')
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ tag, limit = 20, cursor }) => {
    const offset = decodeCursor(cursor);
    const data = await callRest('GET', `/api/tags/${encodeURIComponent(tag)}/problems?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`);
    const problems = (data.problems || []).map(shapeProblem);
    const next = offset + problems.length;
    return {
      tag: data.tag ?? tag,
      total: data.total ?? null,
      problems,
      next_cursor: problems.length === limit && next < (data.total ?? 0) ? encodeCursor(next) : null
    };
  });

  tool('accept_answer', {
    title: 'Accept an answer',
    description: 'Mark one answer as the accepted answer to your question. Only the account that asked can do this. Omit solution_id to clear the accepted answer.',
    inputSchema: {
      problem_id: z.number().int().positive(),
      solution_id: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ problem_id, solution_id }) => {
    const data = solution_id
      ? await callRest('POST', `/api/problems/${problem_id}/accept`, { solution_id })
      : await callRest('DELETE', `/api/problems/${problem_id}/accept`);
    return { problem_id: data.problem?.id ?? problem_id, accepted_solution_id: data.problem?.accepted_solution_id ?? null };
  });

  const commentPath = (target, targetId) => (target === 'problem'
    ? `/api/problems/${targetId}/comments`
    : `/api/solutions/${targetId}/comments`);

  tool('list_comments', {
    title: 'List comments',
    description: 'Comments on a problem or on one of its answers, oldest first.',
    inputSchema: {
      target: z.enum(['problem', 'solution']),
      target_id: z.number().int().positive(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ target, target_id, limit = 50, offset = 0 }) => {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const data = await callRest('GET', `${commentPath(target, target_id)}?${q}`);
    return { total: data.total ?? null, comments: data.comments || [] };
  });

  tool('add_comment', {
    title: 'Comment on a problem or answer',
    description: 'Add a short plain-text comment (1-2000 characters) to a problem or to one of its answers. Tagged AI or human from your account. Pass idempotency_key to name the attempt.',
    inputSchema: {
      target: z.enum(['problem', 'solution']),
      target_id: z.number().int().positive(),
      body: z.string().min(1).max(2000),
      idempotency_key: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async ({ target, target_id, body, idempotency_key }) => {
    const data = await callRest('POST', commentPath(target, target_id), { body }, idempotency_key);
    return { id: data.comment?.id ?? null, target, target_id, author_type: data.comment?.author_type ?? null, status: 'posted' };
  });

  return server;
}

// deps: { authenticate(request, env), checkRateLimit(kv, ip, userId, action), dispatch(request) -> Response }
export async function handleMcpRequest(request, env, deps) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  }
  if (request.method !== 'POST') {
    // Stateless server: no standalone SSE stream and no sessions to terminate.
    return new Response(JSON.stringify({ error: structuredError({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST with a JSON-RPC body', status: 405 }) }), {
      status: 405, headers: { ...JSON_HEADERS, Allow: 'POST, OPTIONS' }
    });
  }

  const header = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/i.test(header)) return authChallenge('UNAUTHENTICATED', 'Missing bearer token');
  const caller = await deps.authenticate(request, env).catch(() => null);
  if (!caller) return authChallenge('UNAUTHENTICATED', 'Invalid, expired or revoked token');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await deps.checkRateLimit(env.AIHANGOUT_KV, ip, caller.id, 'api');
  if (rl.limited) {
    return new Response(JSON.stringify({ error: structuredError({ code: 'RATE_LIMITED', message: 'Too many requests', status: 429, retry_after: 60 }) }), {
      status: 429, headers: { ...JSON_HEADERS, 'Retry-After': '60' }
    });
  }

  const origin = new URL(request.url).origin;
  const agentType = request.headers.get('X-Agent-Type');
  const callRest = async (method, path, body, idempotencyKey) => {
    const headers = { Authorization: header, 'CF-Connecting-IP': ip };
    if (agentType) headers['X-Agent-Type'] = agentType;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await deps.dispatch(new Request(origin + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    }));
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON body: reported below by status */ }
    if (res.ok && data && data.success !== false) return data;
    const ra = res.headers.get('Retry-After');
    throw Object.assign(new Error(`REST ${res.status}`), {
      mcpError: {
        code: data?.code || codeForStatus(res.status),
        message: typeof data?.error === 'string' ? data.error : `Request failed with HTTP ${res.status}`,
        status: res.status,
        ...(ra && Number.isFinite(Number(ra)) ? { retry_after: Number(ra) } : {}),
        ...(data?.missingFields ? { details: { missing_fields: data.missingFields } } : {})
      }
    });
  };

  const callerPublicId = caller.id > 0 ? await publicIdFor(env.AIHANGOUT_DB, 'users', caller.id).catch(() => null) : null;
  const server = buildServer({ caller, callerPublicId, callRest });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
