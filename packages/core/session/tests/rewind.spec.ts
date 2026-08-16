import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionRewindError, buildRewindNotice, foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<{ ctx: Context; sessions: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, sessions: ctx.sessions }
}

async function setupWithInvariants(): Promise<{ sessions: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  return { sessions: ctx.sessions }
}

function appendClosedTurn(
  session: Session,
  turn: number,
  text = `hello ${turn}`,
  reason: TurnEndReason = { kind: 'completed' },
): number {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `reply ${turn}` }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason })
  const end = session.events.at(-1)
  if (end?.type !== 'turn/end') throw new Error('missing turn/end')
  return end.seq
}

function appendOpenTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `open ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Replace the surface range [start..end] with one summary user message (compaction shape). */
function compactRange(session: Session, start: number, end: number, text = 'summary'): void {
  const shadowed = session.surface.nodes.filter(seq => seq >= start && seq <= end)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [...shadowed],
  })
}

function textOf(message: { content: unknown[] }): string {
  const block = message.content[0] as { type: 'text'; text: string }
  if (block?.type !== 'text') throw new Error('not a text block')
  return block.text
}

function userText(session: Session, seq: number): string {
  const event = session.events[seq]
  if (event?.type !== 'user/message') throw new Error(`seq ${seq} is not a user/message`)
  return textOf(event.data)
}

function rewindEvents(session: Session): SessionEvent<'session/rewind'>[] {
  return session.events.filter((e): e is SessionEvent<'session/rewind'> => e.type === 'session/rewind')
}

function derivedTexts(session: Session): string[] {
  return session.deriveMessages().map(textOf)
}

describe('SessionStore.rewind', () => {
  it('rebases derived history to the checkpoint and appends a model-visible notice', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-basic'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendClosedTurn(session, 2, 'second')

    const marker = sessions.rewind(session, turn1End)

    expect(marker).toMatchObject({ type: 'session/rewind', data: { checkpointSeq: turn1End } })
    const notice = session.events.at(-1)
    if (notice?.type !== 'user/message') throw new Error('expected notice message')
    expect(notice.data.source).toMatchObject({ kind: 'rewind', checkpointSeq: turn1End })
    // Derived history: turn-1 prefix plus the notice; turn 2 is voided.
    expect(derivedTexts(session)).toEqual(['first', 'reply 1', expect.stringContaining('rewound')])
  })

  it('keeps the voided span in the log as a branch and records the rewind in the fold', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-branch'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendClosedTurn(session, 2, 'second')

    sessions.rewind(session, turn1End)

    expect(session.events.some(e => e.type === 'user/message' && userText(session, e.seq) === 'second')).toBe(true)
    const fold = foldSurface(session.events)
    expect(fold.rewinds).toEqual([{ seq: rewindEvents(session)[0]!.seq, checkpointSeq: turn1End }])
    const nodeTexts = fold.nodes.map((seq) => {
      const msg = session.deriveEventMessage(session.events[seq]!)
      if (msg === null) throw new Error(`seq ${seq} derives no message`)
      return textOf(msg)
    })
    expect(nodeTexts).toEqual(['first', 'reply 1', expect.stringContaining('rewound')])
  })

  it('stores an optional note on the marker and the notice', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-note'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendClosedTurn(session, 2, 'second')

    sessions.rewind(session, turn1End, { note: 'try again' })

    expect(rewindEvents(session)[0]).toMatchObject({ data: { checkpointSeq: turn1End, note: 'try again' } })
    const notice = session.events.at(-1)
    if (notice?.type !== 'user/message') throw new Error('expected notice message')
    expect(notice.data.source).toMatchObject({ kind: 'rewind', note: 'try again' })
    expect(derivedTexts(session).at(-1)).toContain('Note: try again')
  })

  it('rewinding to the current head is a no-op rebase that still records a notice', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-head'))
    const head = appendClosedTurn(session, 1, 'first')

    sessions.rewind(session, head)

    expect(rewindEvents(session)).toHaveLength(1)
    expect(derivedTexts(session)).toEqual(['first', 'reply 1', expect.stringContaining('rewound')])
  })

  it('rejects boundaries that do not exist', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-bad-boundary'))
    appendClosedTurn(session, 1, 'first')

    for (const bad of [99, -1, 1.5]) {
      try {
        sessions.rewind(session, bad)
        throw new Error('expected rewind to reject')
      } catch (error) {
        expect(error).toBeInstanceOf(SessionRewindError)
        expect((error as SessionRewindError).code).toBe('INVALID_BOUNDARY')
      }
    }
  })

  it('rejects a checkpoint prefix ending inside an open turn', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-open-prefix'))
    appendOpenTurn(session, 1)
    const openSeq = session.seq - 1

    try {
      sessions.rewind(session, openSeq)
      throw new Error('expected rewind to reject')
    } catch (error) {
      expect((error as SessionRewindError).code).toBe('OPEN_TURN')
    }
  })

  it('rejects rewinding while the log tail has an open turn', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-open-tail'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendOpenTurn(session, 2)

    try {
      sessions.rewind(session, turn1End)
      throw new Error('expected rewind to reject')
    } catch (error) {
      expect((error as SessionRewindError).code).toBe('OPEN_TURN')
    }
  })

  it('rejects unknown and stale sources', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-source'))
    const turn1End = appendClosedTurn(session, 1, 'first')

    try {
      sessions.rewind(SessionId('missing'), turn1End)
      throw new Error('expected rewind to reject')
    } catch (error) {
      expect((error as SessionRewindError).code).toBe('SESSION_NOT_FOUND')
    }
    expect(() => sessions.rewind(Session.create(SessionId('stale')), turn1End)).toThrow(SessionRewindError)
  })

  it('does not rewind an empty session', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-empty'))

    try {
      sessions.rewind(session, 0)
      throw new Error('expected rewind to reject')
    } catch (error) {
      expect((error as SessionRewindError).code).toBe('INVALID_BOUNDARY')
    }
  })
})

describe('session/rewind surface semantics', () => {
  it('un-compacts when the checkpoint precedes a compaction in the voided span', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-uncompact'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendClosedTurn(session, 2, 'second')
    const allNodes = session.surface.nodes
    compactRange(session, allNodes[0]!, allNodes.at(-1)!, 'summary')
    expect(derivedTexts(session)).toEqual(['summary'])

    sessions.rewind(session, turn1End)

    expect(derivedTexts(session)).toEqual(['first', 'reply 1', expect.stringContaining('rewound')])
  })

  it('applies a compaction that precedes the checkpoint', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-compacted-prefix'))
    appendClosedTurn(session, 1, 'first')
    const turn1Nodes = session.surface.nodes
    compactRange(session, turn1Nodes[0]!, turn1Nodes.at(-1)!, 'summary')
    const turn2End = appendClosedTurn(session, 2, 'second')

    sessions.rewind(session, turn2End)

    expect(derivedTexts(session)).toEqual(['summary', 'second', 'reply 2', expect.stringContaining('rewound')])
  })

  it('latest rewind wins across multiple rewinds', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-latest'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    const turn2End = appendClosedTurn(session, 2, 'second')
    appendClosedTurn(session, 3, 'third')

    sessions.rewind(session, turn1End)
    appendClosedTurn(session, 4, 'fourth')
    sessions.rewind(session, turn2End)

    expect(derivedTexts(session)).toEqual(['first', 'reply 1', 'second', 'reply 2', expect.stringContaining('rewound')])
    expect(rewindEvents(session)).toHaveLength(2)
  })

  it('rejects a rewind event referencing the future in the fold', async () => {
    const session = Session.create(SessionId('rewind-fold-bad'))
    appendClosedTurn(session, 1, 'first')
    const bad = {
      type: 'session/rewind',
      seq: session.seq,
      time: session.seq,
      data: { checkpointSeq: session.seq },
    } as unknown as SessionEvent

    expect(() => foldSurface([...session.events, bad])).toThrow(/invalid checkpoint seq/)
  })

  it('rejects appending a rewind referencing the future', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-append-bad'))
    appendClosedTurn(session, 1, 'first')

    expect(() => session.append('session/rewind', { checkpointSeq: session.seq })).toThrow(/invalid checkpoint seq/)
  })

  it('live derived messages invalidate their cache across a rewind', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-cache'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendClosedTurn(session, 2, 'second')
    expect(derivedTexts(session)).toEqual(['first', 'reply 1', 'second', 'reply 2'])

    sessions.rewind(session, turn1End)

    expect(derivedTexts(session)).toEqual(['first', 'reply 1', expect.stringContaining('rewound')])
  })

  it('a fork of a rewound session replays the identical derived history', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('rewind-fork-parent'))
    const turn1End = appendClosedTurn(session, 1, 'first')
    appendClosedTurn(session, 2, 'second')
    sessions.rewind(session, turn1End)
    const expected = session.deriveMessages()

    const child = sessions.fork(session)

    expect(child.deriveMessages()).toEqual(expected)
  })
})

describe('buildRewindNotice', () => {
  it('builds a user message with the rewind source', () => {
    const notice = buildRewindNotice(7, 'restart')
    expect(notice).toMatchObject({
      role: 'user',
      source: { kind: 'rewind', checkpointSeq: 7, note: 'restart' },
    })
    expect(textOf(notice)).toContain('Note: restart')
  })
})

describe('session-log invariant for rewind', () => {
  it('rejects a rewind appended inside an open turn', async () => {
    const { sessions } = await setupWithInvariants()
    const session = sessions.create(SessionId('inv-rewind-open'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(() => session.append('session/rewind', { checkpointSeq: 1 })).toThrow(InvariantError)
  })

  it('accepts a rewind appended between turns', async () => {
    const { sessions } = await setupWithInvariants()
    const session = sessions.create(SessionId('inv-rewind-ok'))
    const turn1End = appendClosedTurn(session, 1, 'first')

    expect(() => session.append('session/rewind', { checkpointSeq: turn1End })).not.toThrow()
  })
})
