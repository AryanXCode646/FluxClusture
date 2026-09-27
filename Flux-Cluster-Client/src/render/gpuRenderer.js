// Wall-clock budget, in milliseconds, that the render may run without
// `pathTracer.samples` increasing before it is declared stuck. A frame-count
// budget is not a real duration: the same count means 40 s at 30 Hz but 8 s at
// 144 Hz. Shader compilation pauses accumulation on purpose, so frames spent in
// `pathTracer.isCompiling` never enter the accounting at all instead of being
// given a larger allowance.
export const STALL_TIMEOUT_MS = 15000;

/**
 * Snapshots the shared renderer / path tracer fields that `renderChunk()`
 * overrides for the duration of a tile, so every exit path can put them back.
 *
 * The camera is not part of this snapshot: its aspect ratio is owned by the
 * caller's camera synchronisation (it is recomputed for every task), while the
 * per-tile view offset is undone by `clearViewOffset()` on the same cleanup
 * path.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {object} pathTracer
 * @returns {object} previous values, keyed by the field they belong to.
 */
function captureSharedState(renderer, pathTracer) {
    const shared = {
        pixelRatio: null,
        size: null,
        rasterizeScene: pathTracer.rasterizeScene,
        renderDelay: pathTracer.renderDelay,
        fadeDuration: pathTracer.fadeDuration,
        minSamples: pathTracer.minSamples,
        renderToCanvas: pathTracer.renderToCanvas,
        tiles: null
    };

    if (typeof renderer.getPixelRatio === 'function') {
        shared.pixelRatio = renderer.getPixelRatio();
    } else if (typeof renderer.pixelRatio === 'number') {
        shared.pixelRatio = renderer.pixelRatio;
    }

    if (typeof renderer.getSize === 'function') {
        // three writes through `Vector2.set()`; the shim accepts that as well
        // as a plain `target.width` / `target.height` assignment so stand-in
        // renderers behave exactly like the real one.
        const size = {
            width: 0,
            height: 0,
            set(width, height) {
                this.width = width;
                this.height = height;
                return this;
            }
        };
        renderer.getSize(size);
        shared.size = { width: size.width, height: size.height };
    }

    if (pathTracer.tiles) {
        shared.tiles = { x: pathTracer.tiles.x, y: pathTracer.tiles.y };
    }

    return shared;
}

/**
 * Puts back everything {@link captureSharedState} recorded. Called from the
 * single cleanup funnel, so it runs on success, abort, context loss, timeout
 * and synchronous failures alike. It must never mask the error being reported,
 * hence the guarded body.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {object} pathTracer
 * @param {object} shared values from {@link captureSharedState}.
 */
function restoreSharedState(renderer, pathTracer, shared) {
    try {
        pathTracer.rasterizeScene = shared.rasterizeScene;
        pathTracer.renderDelay = shared.renderDelay;
        pathTracer.fadeDuration = shared.fadeDuration;
        pathTracer.minSamples = shared.minSamples;
        pathTracer.renderToCanvas = shared.renderToCanvas;

        if (shared.tiles && pathTracer.tiles && typeof pathTracer.tiles.set === 'function') {
            pathTracer.tiles.set(shared.tiles.x, shared.tiles.y);
        }
    } catch {
        // A tracer that is already disposed cannot be meaningfully restored;
        // the pending settle still has to happen.
    }

    try {
        // setPixelRatio() re-runs setSize() internally with the current logical
        // size, so the ratio has to come back first for the size to land right.
        if (typeof shared.pixelRatio === 'number' && typeof renderer.setPixelRatio === 'function') {
            renderer.setPixelRatio(shared.pixelRatio);
        }
        if (shared.size && typeof renderer.setSize === 'function') {
            renderer.setSize(shared.size.width, shared.size.height, false);
        }
    } catch {
        // Best effort: the drawing buffer is resized again by the next tile.
    }
}

/**
 * Renders one tile of the full image with WebGLPathTracer and resolves with its
 * RGBA pixels.
 *
 * The path tracer accumulates one tile per `renderSample()` call, ignores calls
 * made while shaders are still compiling, and only composites the accumulated
 * result into the canvas once enough samples exist. Progress is therefore tracked
 * through `pathTracer.samples` rather than a local call counter, and the pixels
 * are read back only after the composite for the requested count has run.
 *
 * Frames spent waiting for `pathTracer.isCompiling` are neither progress nor a
 * stall: they only push the wall-clock watchdog forward. Everything this
 * function borrows from the shared renderer / path tracer is restored before
 * the promise settles.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {object} pathTracer
 * @param {import('three').Camera} camera
 * @param {number} startX Tile left edge in the full image.
 * @param {number} startY Tile bottom edge in the full image.
 * @param {number} chunkWidth
 * @param {number} chunkHeight
 * @param {number} totalWidth
 * @param {number} totalHeight
 * @param {number} samples Requested accumulated samples.
 * @param {Function} [onProgress]
 * @param {AbortSignal} [abortSignal]
 * @param {object} [options] Test seam: `{ stallTimeoutMs, now }` override the
 * watchdog budget and its clock. Production callers use the defaults.
 * @returns {Promise<Uint8Array>} RGBA pixels for the tile, bottom row first.
 */
export function renderChunk(
    renderer,
    pathTracer,
    camera,
    startX,
    startY,
    chunkWidth,
    chunkHeight,
    totalWidth,
    totalHeight,
    samples,
    onProgress,
    abortSignal,
    options = {}
) {
    const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    return new Promise((resolve, reject) => {
        // Captured before the first mutation so the cleanup path can undo it.
        const shared = captureSharedState(renderer, pathTracer);
        const targetSamples = Math.max(1, Math.floor(samples) || 1);

        // Single cleanup funnel: every exit path, including a synchronous
        // failure, restores the shared state and the tile framing exactly once.
        // Anything that throws after setViewOffset would otherwise leave the
        // shared camera permanently offset for every later tile and frame.
        let settled = false;
        const finish = (error, pixels) => {
            if (settled) return;
            settled = true;
            restoreSharedState(renderer, pathTracer, shared);
            try {
                camera.clearViewOffset();
            } catch {
                // Never let cleanup mask the settle that is already running.
            }
            if (error) {
                reject(error);
            } else {
                resolve(pixels);
            }
        };

        // Setup runs inside the promise executor so a synchronous failure rejects
        // instead of escaping as an unhandled error.
        try {
            // This is an offline tile render rather than an interactive preview,
            // so the preview behaviour has to be turned off. The rasterised
            // fallback pass would leave unlit geometry in the default framebuffer,
            // because upgraded GLB lights are path-tracing-only types the
            // rasteriser cannot use, and the render delay plus fade would only
            // postpone the composite this function reads back.
            pathTracer.rasterizeScene = false;
            pathTracer.renderDelay = 0;
            pathTracer.fadeDuration = 0;
            pathTracer.minSamples = 1;
            // The accumulated tile lives in an internal float render target, so
            // the default framebuffer is only authoritative because the tracer
            // composites that target to the canvas. That composite is gated on
            // renderToCanvas and runs at the end of the same update() that
            // advanced the sample, so pin it on rather than relying on it staying
            // the default.
            pathTracer.renderToCanvas = true;
            // Accumulate the whole tile in a single pass so that `samples` counts
            // complete samples. The 3x3 default only exists to keep interactive
            // previews responsive and makes one renderSample() worth 1/9 sample.
            pathTracer.tiles.set(1, 1);

            // One drawing-buffer pixel has to map to exactly one output pixel,
            // otherwise readPixels would only cover part of the tile on HiDPI
            // displays, where the drawing buffer is pixelRatio times larger.
            renderer.setPixelRatio(1);
            renderer.setSize(chunkWidth, chunkHeight, false);

            // Frame the full-image camera onto this tile.
            camera.aspect = totalWidth / totalHeight;
            camera.setViewOffset(totalWidth, totalHeight, startX, startY, chunkWidth, chunkHeight);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld(true);
            pathTracer.updateCamera();

            pathTracer.reset();

            const gl = renderer.getContext();
            let lastProgressAt = now();

            const step = () => {
                // A failure inside the loop has to settle like any other, or the
                // promise would hang after the frame chain dies.
                try {
                    if (abortSignal && abortSignal.aborted) {
                        finish(new Error('Render aborted'));
                        return;
                    }

                    if (gl.isContextLost()) {
                        finish(new Error('WebGL context lost'));
                        return;
                    }

                    const currentTime = now();

                    // Compiling shaders blocks accumulation by design: no sample
                    // is expected, so this is neither progress nor a stall. Only
                    // the watchdog deadline is carried forward, which keeps a
                    // slow compile from being blamed on the renderer once it
                    // finishes.
                    if (pathTracer.isCompiling) {
                        lastProgressAt = currentTime;
                        requestAnimationFrame(step);
                        return;
                    }

                    const samplesBefore = pathTracer.samples;
                    pathTracer.renderSample();

                    if (typeof onProgress === 'function') {
                        onProgress({ samples: pathTracer.samples, maxSamples: targetSamples });
                    }

                    if (pathTracer.samples >= targetSamples) {
                        const pixels = new Uint8Array(chunkWidth * chunkHeight * 4);
                        // renderSample() has just composited the accumulated,
                        // tone mapped tile into the canvas, so read it back from
                        // there.
                        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                        gl.readPixels(0, 0, chunkWidth, chunkHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                        finish(null, pixels);
                        return;
                    }

                    if (pathTracer.samples > samplesBefore) {
                        lastProgressAt = currentTime;
                    } else if (currentTime - lastProgressAt > stallTimeoutMs) {
                        finish(new Error('Path tracer stopped accumulating samples'));
                        return;
                    }

                    requestAnimationFrame(step);
                } catch (error) {
                    finish(error);
                }
            };

            requestAnimationFrame(step);
        } catch (error) {
            finish(error);
        }
    });
}
