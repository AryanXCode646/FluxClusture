// Number of consecutive animation frames that may produce no new samples before
// the render is considered stuck. Shader compilation is reported through
// `isCompiling` and legitimately blocks accumulation, so this only has to
// tolerate a slow first compile, not a hung one.
const MAX_STALLED_FRAMES = 1200;

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
    abortSignal
) {
    return new Promise((resolve, reject) => {
        // Every exit path has to undo the tile framing, including a synchronous
        // failure: anything that throws after setViewOffset would otherwise leave
        // the shared camera permanently offset for every later tile and frame.
        const restoreCamera = () => {
            camera.clearViewOffset();
        };

        // This is an offline tile render rather than an interactive preview, so the
        // preview behaviour has to be turned off. The rasterised fallback pass
        // would leave unlit geometry in the default framebuffer, because upgraded
        // GLB lights are path-tracing-only types the rasteriser cannot use, and
        // the render delay plus fade would only postpone the composite this
        // function reads back.
        pathTracer.rasterizeScene = false;
        pathTracer.renderDelay = 0;
        pathTracer.fadeDuration = 0;
        pathTracer.minSamples = 1;
        // The accumulated tile lives in an internal float render target, so the
        // default framebuffer is only authoritative because the tracer composites
        // that target to the canvas. That composite is gated on renderToCanvas
        // and runs at the end of the same update() that advanced the sample, so
        // pin it on rather than relying on it staying the default.
        pathTracer.renderToCanvas = true;
        // Accumulate the whole tile in a single pass so that `samples` counts
        // complete samples. The 3x3 default only exists to keep interactive
        // previews responsive and makes one renderSample() worth 1/9 sample.
        pathTracer.tiles.set(1, 1);

        const targetSamples = Math.max(1, Math.floor(samples) || 1);

        // Setup runs inside the promise executor so a synchronous failure rejects
        // instead of escaping as an unhandled error.
        try {
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
            let stalledFrames = 0;

            const step = () => {
                if (abortSignal && abortSignal.aborted) {
                    restoreCamera();
                    reject(new Error('Render aborted'));
                    return;
                }

                if (gl.isContextLost()) {
                    restoreCamera();
                    reject(new Error('WebGL context lost'));
                    return;
                }

                const samplesBefore = pathTracer.samples;

                // A compiling material blocks accumulation, so wait for it instead
                // of spending an iteration that renders nothing.
                if (!pathTracer.isCompiling) {
                    pathTracer.renderSample();
                }

                if (typeof onProgress === 'function') {
                    onProgress({ samples: pathTracer.samples, maxSamples: targetSamples });
                }

                if (pathTracer.samples >= targetSamples) {
                    const pixels = new Uint8Array(chunkWidth * chunkHeight * 4);
                    // renderSample() has just composited the accumulated, tone
                    // mapped tile into the canvas, so read it back from there.
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.readPixels(0, 0, chunkWidth, chunkHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                    restoreCamera();
                    resolve(pixels);
                    return;
                }

                stalledFrames = pathTracer.samples > samplesBefore ? 0 : stalledFrames + 1;
                if (stalledFrames > MAX_STALLED_FRAMES) {
                    restoreCamera();
                    reject(new Error('Path tracer stopped accumulating samples'));
                    return;
                }

                requestAnimationFrame(step);
            };

            requestAnimationFrame(step);
        } catch (error) {
            restoreCamera();
            reject(error);
        }
    });
}
