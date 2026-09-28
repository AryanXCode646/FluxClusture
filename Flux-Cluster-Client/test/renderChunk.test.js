import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { renderChunk, STALL_TIMEOUT_MS } from '../src/render/gpuRenderer.js';

// Node has no requestAnimationFrame, so drive the render loop through a queue
// that is drained on the macrotask queue. This keeps the tests deterministic and
// fast while still exercising the real asynchronous frame loop. Frame listeners
// run once per drained frame, before the callbacks, so a test can advance a
// virtual clock or observe state exactly once per animation frame.
let restoreAnimationFrame = null;
const frameListeners = new Set();

before(() => {
    let queue = [];
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
        queue.push(callback);
        setImmediate(() => {
            const pending = queue;
            queue = [];
            if (pending.length === 0) return;
            for (const listener of frameListeners) listener();
            for (const entry of pending) entry(0);
        });
        return queue.length;
    };
    restoreAnimationFrame = () => {
        globalThis.requestAnimationFrame = previous;
    };
});

after(() => {
    frameListeners.clear();
    if (restoreAnimationFrame) restoreAnimationFrame();
});

// A wall clock that only moves when an animation frame is driven, so the
// watchdog tests never depend on real elapsed time or on the host's refresh
// rate. `now` is handed to renderChunk, `tick` is registered as a frame
// listener.
function createVirtualClock(stepMs = 16) {
    let time = 0;
    return {
        stepMs,
        now: () => time,
        tick() {
            time += stepMs;
        }
    };
}

function createFakeRenderer({ pixelRatio = 2, width = 1920, height = 1080 } = {}) {
    const state = {
        pixelRatio,
        size: { width, height, updateStyle: null },
        readPixelsCalls: [],
        framebufferAtRead: 'unset',
        contextLost: false,
        settingsAtReadback: null
    };

    const gl = {
        FRAMEBUFFER: 0x8d40,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        bindFramebuffer(target, framebuffer) {
            state.framebufferAtRead = framebuffer;
        },
        readPixels(x, y, width, height, format, type, pixels) {
            // The settings seen here are the ones the readback actually covered.
            state.settingsAtReadback = { pixelRatio: state.pixelRatio, size: { ...state.size } };
            state.readPixelsCalls.push({ x, y, width, height, format, type, length: pixels.length });
            pixels.fill(7);
        },
        isContextLost() {
            return state.contextLost === true;
        }
    };

    return {
        state,
        gl,
        setPixelRatio(ratio) {
            state.pixelRatio = ratio;
        },
        setSize(width, height, updateStyle) {
            state.size = { width, height, updateStyle };
        },
        getPixelRatio() {
            return state.pixelRatio;
        },
        getSize(target) {
            // three writes through Vector2.set(); accept both shapes.
            if (typeof target.set === 'function') {
                target.set(state.size.width, state.size.height);
            } else {
                target.width = state.size.width;
                target.height = state.size.height;
            }
            return target;
        },
        getContext() {
            return gl;
        }
    };
}

function createFakeCamera() {
    return {
        aspect: 0,
        viewOffset: null,
        viewOffsetHistory: [],
        viewOffsetCleared: false,
        projectionUpdates: 0,
        setViewOffset(fullWidth, fullHeight, x, y, width, height) {
            this.viewOffset = { fullWidth, fullHeight, x, y, width, height };
            this.viewOffsetHistory.push(this.viewOffset);
        },
        clearViewOffset() {
            this.viewOffset = null;
            this.viewOffsetCleared = true;
        },
        updateProjectionMatrix() {
            this.projectionUpdates += 1;
        },
        updateMatrixWorld() {}
    };
}

// Mirrors how three-gpu-pathtracer actually advances: one renderSample() call
// renders a single tile of pathTracer.tiles, so a sample only completes once
// every tile of the grid has been rendered.
//
// `isCompiling` is a polled property: renderChunk reads it exactly once per
// animation frame, so polling is what clocks the compilation window. Every
// value the tests do not expect renderChunk to change is deliberately
// non-default, which makes an unrestored field fail loudly.
function createFakeTracer({ compileFrames = 0, compileForever = false, neverSample = false, sampleDelayFrames = 0 } = {}) {
    const state = {
        samples: 0,
        compileFramesLeft: compileFrames,
        compilePolls: 0,
        sampleDelayLeft: sampleDelayFrames,
        renderSampleCalls: 0,
        resetCalls: 0,
        updateCameraCalls: 0,
        tileProgress: 0
    };

    return {
        state,
        // The library default, so a test fails if renderChunk does not lower it.
        tiles: {
            x: 3,
            y: 3,
            set(x, y) {
                this.x = x;
                this.y = y;
            }
        },
        rasterizeScene: true,
        renderToCanvas: false,
        renderDelay: 100,
        fadeDuration: 500,
        minSamples: 5,
        get samples() {
            return state.samples;
        },
        get isCompiling() {
            if (compileForever) {
                state.compilePolls += 1;
                return true;
            }
            if (state.compileFramesLeft > 0) {
                state.compilePolls += 1;
                state.compileFramesLeft -= 1;
                return true;
            }
            return false;
        },
        updateCamera() {
            state.updateCameraCalls += 1;
        },
        reset() {
            state.resetCalls += 1;
            state.samples = 0;
            state.tileProgress = 0;
            state.compilePolls = 0;
            state.compileFramesLeft = compileForever ? Infinity : compileFrames;
            state.sampleDelayLeft = sampleDelayFrames;
        },
        renderSample() {
            state.renderSampleCalls += 1;
            if (state.compileFramesLeft > 0 || neverSample) return;
            // Warm-up frames: a real tracer can spend a call or two after a
            // recompile before the first sample lands, and those frames must not
            // inherit a stall deadline that expired during compilation.
            if (state.sampleDelayLeft > 0) {
                state.sampleDelayLeft -= 1;
                return;
            }
            state.tileProgress += 1;
            if (state.tileProgress >= this.tiles.x * this.tiles.y) {
                state.tileProgress = 0;
                state.samples += 1;
            }
        }
    };
}

// The shared settings renderChunk borrows for the duration of a tile, captured
// while the tile is still rendering (progress is reported before the cleanup
// funnel runs).
function snapshotRenderConfig(renderer, tracer) {
    return {
        pixelRatio: renderer.state.pixelRatio,
        rendererSize: { width: renderer.state.size.width, height: renderer.state.size.height },
        tiles: { x: tracer.tiles.x, y: tracer.tiles.y },
        rasterizeScene: tracer.rasterizeScene,
        renderToCanvas: tracer.renderToCanvas,
        renderDelay: tracer.renderDelay,
        fadeDuration: tracer.fadeDuration,
        minSamples: tracer.minSamples
    };
}

// The fake tracer and renderer start from non-default values; this is the state
// every exit path has to hand back.
function assertSharedStateRestored(renderer, tracer, { pixelRatio = 2, width = 1920, height = 1080 } = {}) {
    assert.equal(renderer.state.pixelRatio, pixelRatio, 'the renderer pixel ratio must be restored');
    assert.deepEqual(
        { width: renderer.state.size.width, height: renderer.state.size.height },
        { width, height },
        'the renderer size must be restored'
    );
    assert.equal(tracer.rasterizeScene, true, 'rasterizeScene must be restored');
    assert.equal(tracer.renderToCanvas, false, 'renderToCanvas must be restored');
    assert.equal(tracer.renderDelay, 100, 'renderDelay must be restored');
    assert.equal(tracer.fadeDuration, 500, 'fadeDuration must be restored');
    assert.equal(tracer.minSamples, 5, 'minSamples must be restored');
    assert.deepEqual({ x: tracer.tiles.x, y: tracer.tiles.y }, { x: 3, y: 3 }, 'tiles must be restored');
}

// Drives a tracer that never produces a sample until the watchdog gives up,
// with a virtual clock, so "stalled for a second" costs a few dozen animation
// frames instead of a real sleep and cannot depend on the host's timers.
async function runStalledRender(stepMs) {
    const renderer = createFakeRenderer();
    const camera = createFakeCamera();
    const tracer = createFakeTracer({ neverSample: true });
    const clock = createVirtualClock(stepMs);
    const stallTimeoutMs = 1000;
    frameListeners.add(clock.tick);

    try {
        const promise = renderChunk(
            renderer,
            tracer,
            camera,
            0, 0, 64, 64, 192, 192, 8,
            undefined,
            undefined,
            { stallTimeoutMs, now: clock.now }
        );
        await assert.rejects(promise, /stopped accumulating/);
    } finally {
        frameListeners.delete(clock.tick);
    }

    return { clock, camera, renderer, tracer, stallTimeoutMs };
}

function createRun({ samples = 8, startX = 32, startY = 64, width = 64, height = 64, totalWidth = 192, totalHeight = 192, tracer, renderer, camera, signal, options } = {}) {
    const progress = [];
    const promise = renderChunk(
        renderer,
        tracer,
        camera,
        startX,
        startY,
        width,
        height,
        totalWidth,
        totalHeight,
        samples,
        (data) => progress.push({ ...data, config: snapshotRenderConfig(renderer, tracer) }),
        signal,
        options
    );
    return { promise, progress };
}

describe('renderChunk', () => {
    it('configures the path tracer for an offline single-tile render', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise, progress } = createRun({ renderer, camera, tracer, samples: 4 });
        await promise;

        const config = progress[0].config;
        assert.equal(config.pixelRatio, 1, 'pixel ratio must be 1 so readPixels covers the whole tile');
        assert.deepEqual(
            { width: config.rendererSize.width, height: config.rendererSize.height },
            { width: 64, height: 64 },
            'the drawing buffer must match the tile exactly'
        );
        assert.deepEqual(config.tiles, { x: 1, y: 1 });
        assert.equal(config.rasterizeScene, false, 'the rasterised fallback must not overwrite the tile');
        assert.equal(config.renderToCanvas, true, 'the tracer must composite its target to the canvas we read back');
        assert.equal(config.renderDelay, 0);
        assert.equal(config.fadeDuration, 0);
        assert.equal(config.minSamples, 1);
        assert.equal(tracer.state.resetCalls, 1);
    });

    it('frames the camera onto the requested tile and restores it afterwards', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise } = createRun({
            renderer,
            camera,
            tracer,
            startX: 32,
            startY: 64,
            width: 64,
            height: 64,
            totalWidth: 192,
            totalHeight: 96
        });
        await promise;

        assert.equal(camera.aspect, 192 / 96);
        assert.deepEqual(camera.viewOffsetHistory, [
            { fullWidth: 192, fullHeight: 96, x: 32, y: 64, width: 64, height: 64 }
        ]);
        assert.equal(camera.viewOffset, null, 'the tile view offset must not leak into the next tile');
        assert.equal(camera.projectionUpdates, 1);
        assert.equal(tracer.state.updateCameraCalls, 1);
    });

    // Regression test for the reported solid black/white frames: the old code
    // counted renderSample() calls, so a 3x3 tile grid made it declare a tile
    // finished after 1/9 of the requested samples and ship the raster fallback.
    it('does not resolve before the path tracer reports the requested samples', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const samples = 8;
        const { promise } = createRun({ renderer, camera, tracer, samples });
        const pixels = await promise;

        assert.equal(tracer.state.samples, samples, 'must accumulate the full requested sample count');
        assert.equal(
            tracer.state.renderSampleCalls,
            samples,
            'a single-tile grid must make one renderSample() worth one sample'
        );
        assert.equal(pixels.length, 64 * 64 * 4);
    });

    it('waits out shader compilation without burning iterations', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer({ compileFrames: 3 });

        const samples = 5;
        const { promise } = createRun({ renderer, camera, tracer, samples });
        await promise;

        assert.equal(tracer.state.samples, samples);
        assert.equal(tracer.state.compilePolls, 3, 'the tracer must have been polled while compiling');
        assert.equal(tracer.state.renderSampleCalls, samples, 'renderSample() must be skipped while compiling');
    });

    // Regression test for the blocking review comment: renderChunk() skips
    // renderSample() while pathTracer.isCompiling, so an animation-frame stall
    // budget would count those frames as a hang and reject a perfectly healthy
    // render. The budget is wall-clock and compilation frames are excluded from
    // the accounting entirely, which this proves by running compilation for far
    // longer than the stall timeout.
    it('does not reject when compilation outlasts the stall timeout', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        // sampleDelayFrames keeps the tracer quiet for two calls after the
        // recompile, so a deadline that the compilation left stale would be
        // judged on the first frames after it ends.
        const tracer = createFakeTracer({ compileFrames: 1250, sampleDelayFrames: 2 });
        const clock = createVirtualClock(16);
        const stallTimeoutMs = 500;

        const samplesDuringCompile = [];
        let compileEndsAt = null;
        const observe = () => {
            if (tracer.state.compileFramesLeft > 0) {
                samplesDuringCompile.push(tracer.state.samples);
            } else if (compileEndsAt === null) {
                compileEndsAt = clock.now();
            }
        };
        frameListeners.add(clock.tick);
        frameListeners.add(observe);

        try {
            const samples = 6;
            const { promise, progress } = createRun({
                renderer,
                camera,
                tracer,
                samples,
                options: { stallTimeoutMs, now: clock.now }
            });
            const pixels = await promise;

            assert.ok(compileEndsAt !== null, 'the compilation window must actually end');
            assert.ok(
                compileEndsAt > stallTimeoutMs,
                `compilation must outlive the ${stallTimeoutMs}ms budget (ended at ${compileEndsAt}ms)`
            );
            assert.ok(
                samplesDuringCompile.length > 1000,
                'the test must observe a compilation spanning many frames'
            );
            assert.ok(
                samplesDuringCompile.every((value) => value === 0),
                'samples must not move while the tracer is compiling'
            );
            assert.equal(tracer.state.samples, samples, 'sampling must resume after compilation');
            assert.equal(
                tracer.state.renderSampleCalls,
                samples + 2,
                'renderSample() must be skipped while compiling, then warm up before the first sample'
            );
            assert.equal(
                progress.length,
                tracer.state.renderSampleCalls,
                'only frames that ran renderSample() may report progress'
            );
            assert.equal(progress[progress.length - 1].samples, samples, 'progress must reach the target sample count');
            for (let i = 1; i < progress.length; i++) {
                assert.ok(progress[i].samples >= progress[i - 1].samples, 'progress must never regress');
            }
            assert.equal(pixels.length, 64 * 64 * 4);
        } finally {
            frameListeners.delete(clock.tick);
            frameListeners.delete(observe);
        }
    });

    it('reads the composited tile back from the default framebuffer', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise } = createRun({ renderer, camera, tracer, samples: 2, width: 8, height: 4 });
        const pixels = await promise;

        assert.equal(renderer.state.framebufferAtRead, null, 'read from the default framebuffer, not a render target');
        assert.deepEqual(renderer.state.readPixelsCalls, [
            { x: 0, y: 0, width: 8, height: 4, format: renderer.gl.RGBA, type: renderer.gl.UNSIGNED_BYTE, length: 8 * 4 * 4 }
        ]);
        assert.deepEqual(
            { width: renderer.state.settingsAtReadback.size.width, height: renderer.state.settingsAtReadback.size.height },
            { width: 8, height: 4 },
            'the readback must cover the whole tile, not a stale drawing buffer'
        );
        assert.equal(renderer.state.settingsAtReadback.pixelRatio, 1);
        assert.equal(pixels[0], 7);
    });

    it('reports the path tracer sample count as progress', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise, progress } = createRun({ renderer, camera, tracer, samples: 4 });
        await promise;

        assert.ok(progress.length > 0, 'progress must be reported while a tile renders');
        for (const entry of progress) {
            assert.equal(entry.maxSamples, 4);
            assert.ok(entry.samples >= 0 && entry.samples <= 4, `sample count ${entry.samples} out of range`);
        }
        for (let i = 1; i < progress.length; i++) {
            assert.ok(progress[i].samples > progress[i - 1].samples, 'progress must advance with real samples');
        }
        assert.equal(progress[progress.length - 1].samples, 4, 'progress must reach the requested sample count');
    });

    it('always renders at least one sample', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise } = createRun({ renderer, camera, tracer, samples: 0 });
        await promise;

        assert.equal(tracer.state.samples, 1);
    });

    it('restores the shared renderer and tracer state after a successful render', async () => {
        const renderer = createFakeRenderer({ pixelRatio: 3, width: 800, height: 600 });
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise, progress } = createRun({ renderer, camera, tracer, samples: 4 });
        await promise;

        const during = progress[progress.length - 1].config;
        assert.equal(during.pixelRatio, 1, 'the tile must render with the borrowed settings');
        assert.deepEqual({ width: during.rendererSize.width, height: during.rendererSize.height }, { width: 64, height: 64 });
        assert.deepEqual(during.tiles, { x: 1, y: 1 });
        assert.equal(during.rasterizeScene, false);
        assert.equal(during.renderToCanvas, true);

        assertSharedStateRestored(renderer, tracer, { pixelRatio: 3, width: 800, height: 600 });
        assert.equal(camera.viewOffset, null, 'the tile view offset must not leak into the next tile');
    });

    it('rejects and restores the shared state when the render is aborted', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();
        const abortController = new AbortController();
        abortController.abort();

        const promise = renderChunk(
            renderer, tracer, camera, 0, 0, 64, 64, 192, 192, 8, undefined, abortController.signal
        );
        await assert.rejects(promise, /Render aborted/);
        assert.equal(camera.viewOffsetCleared, true);
        assertSharedStateRestored(renderer, tracer);
    });

    it('rejects and restores the shared state when the WebGL context is lost', async () => {
        const renderer = createFakeRenderer();
        renderer.state.contextLost = true;
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const promise = renderChunk(renderer, tracer, camera, 0, 0, 64, 64, 192, 192, 8, undefined, undefined);
        await assert.rejects(promise, /WebGL context lost/);
        assert.equal(camera.viewOffsetCleared, true);
        assertSharedStateRestored(renderer, tracer);
    });

    it('rejects once the wall-clock stall timeout elapses without new samples', async () => {
        const stepMs = 16;
        const { clock, camera, renderer, tracer, stallTimeoutMs } = await runStalledRender(stepMs);

        assert.ok(
            clock.now() > stallTimeoutMs,
            `the watchdog must wait out the full ${stallTimeoutMs}ms budget (stopped at ${clock.now()}ms)`
        );
        assert.ok(
            clock.now() <= stallTimeoutMs + 2 * stepMs,
            'and must reject as soon as that budget is exceeded'
        );
        assert.equal(
            tracer.state.renderSampleCalls,
            Math.floor(stallTimeoutMs / stepMs) + 1,
            'one fruitless call per frame until the budget ran out'
        );
        assert.equal(camera.viewOffsetCleared, true);
        assertSharedStateRestored(renderer, tracer);
    });

    // The old budget counted animation frames, so the same setting meant 40 s at
    // 30 Hz and 8 s at 144 Hz. Running the identical stall over two frame rates
    // must therefore spend the same elapsed time but a different number of
    // frames.
    it('measures the stall budget in elapsed time rather than animation frames', async () => {
        const fastFrames = await runStalledRender(16);
        const slowFrames = await runStalledRender(100);

        const { stallTimeoutMs } = fastFrames;
        assert.ok(
            fastFrames.clock.now() > stallTimeoutMs && fastFrames.clock.now() <= stallTimeoutMs + 2 * 16,
            `16ms frames must reject at ${stallTimeoutMs}ms (stopped at ${fastFrames.clock.now()}ms)`
        );
        assert.ok(
            slowFrames.clock.now() > stallTimeoutMs && slowFrames.clock.now() <= stallTimeoutMs + 2 * 100,
            `100ms frames must reject at ${stallTimeoutMs}ms (stopped at ${slowFrames.clock.now()}ms)`
        );
        assert.notEqual(
            fastFrames.tracer.state.renderSampleCalls,
            slowFrames.tracer.state.renderSampleCalls,
            'the same elapsed budget must buy a different number of frames'
        );
        assert.equal(
            fastFrames.tracer.state.renderSampleCalls - 1,
            Math.floor(stallTimeoutMs / 16),
            'the fast frame rate must have produced more attempts within the budget'
        );
        assert.equal(slowFrames.tracer.state.renderSampleCalls - 1, Math.floor(stallTimeoutMs / 100));
    });

    it('uses a wall-clock stall budget rather than a frame count', () => {
        // Guards against regressing to MAX_STALLED_FRAMES-style accounting,
        // where the same budget meant a different real duration at 30/144 Hz.
        assert.equal(typeof STALL_TIMEOUT_MS, 'number');
        assert.ok(STALL_TIMEOUT_MS > 0);
        assert.ok(STALL_TIMEOUT_MS <= 60000, 'a healthy render must never be this slow to add a sample');
    });

    it('stops requesting animation frames once the render is done', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise } = createRun({ renderer, camera, tracer, samples: 3 });
        await promise;

        const callsAtResolve = tracer.state.renderSampleCalls;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(tracer.state.renderSampleCalls, callsAtResolve, 'the render loop must not outlive the tile');
    });

    it('stops requesting animation frames after an abort', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();
        const abortController = new AbortController();

        const promise = renderChunk(
            renderer, tracer, camera, 0, 0, 64, 64, 192, 192, 8, undefined, abortController.signal
        );
        abortController.abort();
        await assert.rejects(promise, /Render aborted/);

        const callsAtAbort = tracer.state.renderSampleCalls;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(tracer.state.renderSampleCalls, callsAtAbort, 'an aborted render must not keep working');
    });

    it('clears the camera and restores shared state when setup throws after framing the tile', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();
        // reset() runs after setViewOffset(), so this is the window in which a
        // synchronous failure would strand the shared camera on this tile.
        tracer.reset = () => {
            throw new Error('context lost during reset');
        };

        await assert.rejects(
            renderChunk(renderer, tracer, camera, 0, 0, 64, 64, 192, 192, 8, undefined, undefined),
            /context lost during reset/
        );
        assert.equal(camera.viewOffsetCleared, true, 'a failed setup must not leave the camera offset');
        assertSharedStateRestored(renderer, tracer);
    });
});
