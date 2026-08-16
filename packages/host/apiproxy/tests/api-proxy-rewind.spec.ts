/** Session-rewind boundaries, agent cancellation, and notice semantics. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`rewind-${String(nextRpc++)}`), payload }
}

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return ctx
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

function userSeq(session: Session, turn: number): number {
  const event = session.events.find(e => e.type === 'user/message'
    && e.data.source.kind === 'user' && session.events.slice(0, e.seq).filter(x => x.type === 'turn/start').length === turn)
  if (event === undefined) throw new Error(`missing user message for turn ${turn}`)
  return event.seq
}

function liveAgent(
  ctx: Context,
  id: string,
  turns: number,
  running = false,
): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  ctx.agents.register({
    id: session.id,
    session,
    status: running ? 'running' : 'idle',
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    ctx,
  } as unknown as Agent)
  return session
}

function texts(session: Session): string[] {
  return session.deriveMessages().map((message) => {
    const block = message.content[0] as { type: 'text'; text: string }
    return block.text
  })
}

describe('sessions.rewind', () => {
  it('rebases derived history to the anchored turn and appends the notice', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rewind', 2)
    const anchor = userSeq(source, 1)

    const response = await api(ctx).sessions.rewind(request({ sessionId: source.id, atSeq: anchor }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const tail = source.events.slice(-2)
    expect(tail[0]).toMatchObject({ type: 'session/rewind', data: { checkpointSeq: expect.any(Number) } })
    expect(tail[1]).toMatchObject({ type: 'user/message' })
    expect((tail[1]?.data as { source: { kind: string } }).source.kind).toBe('rewind')
    expect(texts(source)).toEqual(['prompt 1', expect.stringContaining('rewound')])
    await ctx.fiber.dispose()
  })

  it('keeps the voided span in the log as a branch', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rewind-branch', 2)
    const anchor = userSeq(source, 1)

    const response = await api(ctx).sessions.rewind(request({ sessionId: source.id, atSeq: anchor }))

    expect(response.result.ok).toBe(true)
    expect(source.events.some(e => e.type === 'user/message'
      && (e.data.content[0] as { text: string }).text === 'prompt 2')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('falls back to the last completed turn when the anchor is omitted', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rewind-last', 2)

    const response = await api(ctx).sessions.rewind(request({ sessionId: source.id }))

    expect(response.result.ok).toBe(true)
    expect(texts(source)).toEqual(['prompt 1', 'prompt 2', expect.stringContaining('rewound')])
    await ctx.fiber.dispose()
  })

  it('cancels a running agent before rewinding', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rewind-running', 2, true)
    const agent = ctx.agents.get(source.id)
    const cancel = vi.fn()
    if (agent === undefined) throw new Error('missing agent')
    Object.assign(agent, { cancel, whenIdle: () => Promise.resolve() })
    const anchor = userSeq(source, 1)

    const response = await api(ctx).sessions.rewind(request({ sessionId: source.id, atSeq: anchor }))

    expect(response.result.ok).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    await ctx.fiber.dispose()
  })

  it('rejects an anchor whose turn is still open', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rewind-open', 1)
    source.append('turn/start', { turn: 2 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const openUser = userSeq(source, 2)

    const response = await api(ctx).sessions.rewind(request({ sessionId: source.id, atSeq: openUser }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) return
    expect(response.result.error.code).toBe('rewind-unavailable')
    await ctx.fiber.dispose()
  })

  it('rejects a session that is not live', async () => {
    const ctx = await composed()
    const response = await api(ctx).sessions.rewind(request({ sessionId: sid('missing') }))
    expect(response.result.ok).toBe(false)
    await ctx.fiber.dispose()
  })
})
