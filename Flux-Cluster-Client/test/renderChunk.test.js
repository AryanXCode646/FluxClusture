import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { renderChunk } from '../src/render/gpuRenderer.js';

// Node has no requestAnimationFrame, so drive the render loop through a queue
// that is drained on the macrotask queue. This keeps the tests deterministic and
// fast while still exercising the real asynchronous frame loop.
let restoreAnimationFrame = null;

before(() => {
    let queue = [];
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
        queue.push(callback);
        setImmediate(() => {
            const pending = queue;
            queue = [];
            for (const entry of pending) entry(0);
        });
        return queue.length;
    };
    restoreAnimationFrame = () => {
        globalThis.requestAnimationFrame = previous;
    };
});

after(() => {
    if (restoreAnimationFrame) restoreAnimationFrame();
});

function createFakeRenderer() {
    const state = { pixelRatio: null, size: null, readPixelsCalls: [], framebufferAtRead: 'unset' };

    const gl = {
        FRAMEBUFFER: 0x8d40,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        bindFramebuffer(target, framebuffer) {
            state.framebufferAtRead = framebuffer;
        },
        readPixels(x, y, width, height, format, type, pixels) {
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
function createFakeTracer({ compileFrames = 0, compileForever = false, neverSample = false } = {}) {
    const state = {
        samples: 0,
        isCompiling: false,
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
            return state.isCompiling;
        },
        updateCamera() {
            state.updateCameraCalls += 1;
        },
        reset() {
            state.resetCalls += 1;
            state.samples = 0;
            state.tileProgress = 0;
            if (compileForever) {
                state.isCompiling = true;
                return;
            }
            if (compileFrames > 0) {
                state.isCompiling = true;
                setTimeout(() => {
                    state.isCompiling = false;
                }, 0);
            }
        },
        renderSample() {
            state.renderSampleCalls += 1;
            if (state.isCompiling || neverSample) return;
            state.tileProgress += 1;
            if (state.tileProgress >= this.tiles.x * this.tiles.y) {
                state.tileProgress = 0;
                state.samples += 1;
            }
        }
    };
}

function createRun({ samples = 8, startX = 32, startY = 64, width = 64, height = 64, totalWidth = 192, totalHeight = 192, tracer, renderer, camera } = {}) {
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
        (data) => progress.push({ ...data }),
        undefined
    );
    return { promise, progress };
}

describe('renderChunk', () => {
    it('configures the path tracer for an offline single-tile render', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const { promise } = createRun({ renderer, camera, tracer, samples: 4 });
        await promise;

        assert.equal(renderer.state.pixelRatio, 1, 'pixel ratio must be 1 so readPixels covers the whole tile');
        assert.deepEqual(renderer.state.size, { width: 64, height: 64, updateStyle: false });
        assert.deepEqual({ x: tracer.tiles.x, y: tracer.tiles.y }, { x: 1, y: 1 });
        assert.equal(tracer.rasterizeScene, false, 'the rasterised fallback must not overwrite the tile');
        assert.equal(tracer.renderToCanvas, true, 'the tracer must composite its target to the canvas we read back');
        assert.equal(tracer.renderDelay, 0);
        assert.equal(tracer.fadeDuration, 0);
        assert.equal(tracer.minSamples, 1);
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
        assert.equal(tracer.state.renderSampleCalls, samples, 'renderSample() must be skipped while compiling');
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

    it('rejects and restores the camera when the render is aborted', async () => {
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
    });

    it('rejects when the WebGL context is lost', async () => {
        const renderer = createFakeRenderer();
        renderer.state.contextLost = true;
        const camera = createFakeCamera();
        const tracer = createFakeTracer();

        const promise = renderChunk(renderer, tracer, camera, 0, 0, 64, 64, 192, 192, 8, undefined, undefined);
        await assert.rejects(promise, /WebGL context lost/);
        assert.equal(camera.viewOffsetCleared, true);
    });

    it('rejects instead of hanging when the path tracer never accumulates', async () => {
        const renderer = createFakeRenderer();
        const camera = createFakeCamera();
        const tracer = createFakeTracer({ neverSample: true });

        const promise = renderChunk(renderer, tracer, camera, 0, 0, 64, 64, 192, 192, 8, undefined, undefined);
        await assert.rejects(promise, /stopped accumulating/);
        assert.equal(camera.viewOffsetCleared, true);
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

    it('clears the camera offset when setup throws after framing the tile', async () => {
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
    });
});
