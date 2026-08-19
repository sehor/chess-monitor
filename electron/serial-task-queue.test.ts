import { describe, expect, it } from 'vitest'
import { SerialTaskQueue } from './serial-task-queue'

describe('SerialTaskQueue', () => {
  it('runs overlapping asynchronous mutations in request order', async () => {
    const queue = new SerialTaskQueue()
    const events: string[] = []
    let releaseFirst: (() => void) | undefined

    const first = queue.run(async () => {
      events.push('first:start')
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      events.push('first:end')
      return 'first'
    })
    const second = queue.run(async () => {
      events.push('second:start')
      events.push('second:end')
      return 'second'
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('continues with the next mutation after a failure', async () => {
    const queue = new SerialTaskQueue()
    const failed = queue.run(async () => { throw new Error('first failed') })
    const recovered = queue.run(async () => 'second completed')

    await expect(failed).rejects.toThrow('first failed')
    await expect(recovered).resolves.toBe('second completed')
  })

  it('keeps realtime start behind an in-flight profile activation', async () => {
    const queue = new SerialTaskQueue()
    let activeProfile = 'old-profile'
    let releasePrepare: (() => void) | undefined
    let startedWithProfile: string | undefined

    const activation = queue.run(async () => {
      await new Promise<void>((resolve) => { releasePrepare = resolve })
      activeProfile = 'new-profile'
    })
    const realtimeStart = queue.run(async () => {
      startedWithProfile = activeProfile
    })

    await Promise.resolve()
    expect(startedWithProfile).toBeUndefined()
    releasePrepare?.()
    await Promise.all([activation, realtimeStart])
    expect(startedWithProfile).toBe('new-profile')
  })
})
