import { describe, it, expect, vi, afterEach } from 'vitest'
import { MjpegStreamer } from '../MjpegStreamer'
import type { SimctlWrapper } from '../SimctlWrapper'

type Screenshottable = Pick<SimctlWrapper, 'screenshot'>

function mockSimctl(frame = Buffer.from('png')): Screenshottable {
  return { screenshot: vi.fn().mockResolvedValue(frame) }
}

describe('MjpegStreamer', () => {
  afterEach(() => vi.useRealTimers())

  it('emits the first frame immediately', async () => {
    const frame = Buffer.from('frame-data')
    const simctl = mockSimctl(frame)
    const streamer = new MjpegStreamer(simctl, 'dev-1', 1000)

    const stream = streamer.start()
    const reader = stream.getReader()
    const { value } = await reader.read()

    expect(value).toEqual({ payload: frame, keyframe: false })
    await reader.cancel()
  })

  it('asks simctl for JPEG, which is what the frames are stamped as', async () => {
    // The default is PNG, so omitting the argument made this streamer produce PNG bytes under
    // `CODEC_JPEG` — the class names its codec and was the one place still getting it wrong after
    // #508. Asserted on the call because the bytes here are a fixture: what is checkable is which
    // format was requested.
    const simctl = mockSimctl()
    const streamer = new MjpegStreamer(simctl, 'dev-1', 1000)

    const reader = streamer.start().getReader()
    await reader.read()

    expect(simctl.screenshot).toHaveBeenCalledWith('dev-1', 'jpeg')
    await reader.cancel()
  })

  it('emits multiple frames at the given interval', async () => {
    vi.useFakeTimers()
    const simctl = mockSimctl()
    const streamer = new MjpegStreamer(simctl, 'dev-1', 100)

    streamer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(simctl.screenshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    expect(simctl.screenshot).toHaveBeenCalledTimes(3)
  })

  it('stops emitting after cancel', async () => {
    vi.useFakeTimers()
    const simctl = mockSimctl()
    const streamer = new MjpegStreamer(simctl, 'dev-1', 100)

    const stream = streamer.start()
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()

    await vi.advanceTimersByTimeAsync(300)
    expect(simctl.screenshot).toHaveBeenCalledTimes(1)
  })

  it('surfaces a capture failure to the reader instead of stalling it', async () => {
    // The `catch` arm of the capture had no test: replacing `controller.error(err)` with `void err`
    // left all eight tests across this file and the perf one green. A reader waiting on a stream
    // nobody errors waits forever, and a screenshot rejecting mid-stream is what a simulator being
    // shut down under a live session looks like.
    vi.useFakeTimers()
    const screenshot = vi.fn().mockRejectedValue(new Error('simulator went away'))
    const streamer = new MjpegStreamer({ screenshot }, 'dev-1', 100)

    const reader = streamer.start().getReader()

    await expect(reader.read()).rejects.toThrow('simulator went away')
  })

  it('skips a capture if the previous one is still in progress', async () => {
    vi.useFakeTimers()
    let resolve!: () => void
    const slowScreenshot = vi.fn(
      () => new Promise<Buffer>((r) => { resolve = () => r(Buffer.from('x')) })
    )
    const streamer = new MjpegStreamer({ screenshot: slowScreenshot }, 'dev-1', 100)

    // capture() is called synchronously — capturing = true before first await
    streamer.start()

    // interval fires while first capture is still pending
    await vi.advanceTimersByTimeAsync(100)
    expect(slowScreenshot).toHaveBeenCalledTimes(1)

    resolve()
  })
})
