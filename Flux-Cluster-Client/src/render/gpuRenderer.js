import { ensurePathTracerEnvironment } from './upgradeLights.js';

// Wall-clock budget, in milliseconds, that the render may run without
// `pathTracer.samples` increasing before it is declared stuck. A frame-count
// budget is not a real duration: the same count means 40 s at 30 Hz but 8 s at
// 144 Hz. Shader compilation pauses accumulation on purpose, so frames spent in
// `pathTracer.isCompiling` never enter the accounting at all instead of being
// given a larger allowance.
export const STALL_TIMEOUT_MS = 15000;

/**
 * Snapshots the shared renderer / path tracer / camera fields that `renderChunk()`
 * overrides for the duration of a tile, so every exit path can put them back.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {object} pathTracer
 * @param {import('three').Camera} [camera]
 * @returns {object} previous values, keyed by the field they belong to.
 */
function captureSharedState(renderer, pathTracer, camera) {
    const shared = {
        pixelRatio: null,
        size: null,
        renderTarget: null,
        viewport: null,
        scissor: null,
        scissorTest: null,
        autoClear: renderer?.autoClear,
        cameraAspect: camera?.aspect ?? null,
        rasterizeScene: pathTracer.rasterizeScene,
        renderDelay: pathTracer.renderDelay,
        fadeDuration: pathTracer.fadeDuration,
        minSamples: pathTracer.minSamples,
        renderToCanvas: pathTracer.renderToCanvas,
        tiles: null,
        previousGlFramebuffer: undefined
    };

    if (typeof renderer.getPixelRatio === 'function') {
        shared.pixelRatio = renderer.getPixelRatio();
    } else if (typeof renderer.pixelRatio === 'number') {
        shared.pixelRatio = renderer.pixelRatio;
    }

    if (typeof renderer.getSize === 'function') {
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

    if (typeof renderer.getRenderTarget === 'function') {
        shared.renderTarget = renderer.getRenderTarget();
    }

    if (typeof renderer.getViewport === 'function') {
        const vp = {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            set(x, y, width, height) {
                this.x = x;
                this.y = y;
                this.width = width;
                this.height = height;
                return this;
            },
            copy(other) {
                this.x = other.x;
                this.y = other.y;
                this.width = other.width;
                this.height = other.height;
                return this;
            }
        };
        renderer.getViewport(vp);
        shared.viewport = { x: vp.x, y: vp.y, width: vp.width, height: vp.height };
    }

    if (typeof renderer.getScissor === 'function') {
        const sc = {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            set(x, y, width, height) {
                this.x = x;
                this.y = y;
                this.width = width;
                this.height = height;
                return this;
            },
            copy(other) {
                this.x = other.x;
                this.y = other.y;
                this.width = other.width;
                this.height = other.height;
                return this;
            }
        };
        renderer.getScissor(sc);
        shared.scissor = { x: sc.x, y: sc.y, width: sc.width, height: sc.height };
    }

    if (typeof renderer.getScissorTest === 'function') {
        shared.scissorTest = renderer.getScissorTest();
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
 * @param {import('three').Camera} camera
 * @param {object} shared values from {@link captureSharedState}.
 */
function restoreSharedState(renderer, pathTracer, camera, shared) {
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
        // A tracer that is already disposed cannot be meaningfully restored.
    }

    try {
        if (shared.previousGlFramebuffer !== undefined && typeof renderer.getContext === 'function') {
            const gl = renderer.getContext();
            if (gl && typeof gl.bindFramebuffer === 'function') {
                gl.bindFramebuffer(gl.FRAMEBUFFER, shared.previousGlFramebuffer);
            }
        }
    } catch {
        // Best effort GL framebuffer restore.
    }

    try {
        if (typeof renderer.setRenderTarget === 'function') {
            renderer.setRenderTarget(shared.renderTarget ?? null);
        }
    } catch {
        // Render target restore
    }

    try {
        if (shared.viewport && typeof renderer.setViewport === 'function') {
            renderer.setViewport(shared.viewport.x, shared.viewport.y, shared.viewport.width, shared.viewport.height);
        }
    } catch {
        // Viewport restore
    }

    try {
        if (shared.scissor && typeof renderer.setScissor === 'function') {
            renderer.setScissor(shared.scissor.x, shared.scissor.y, shared.scissor.width, shared.scissor.height);
        }
    } catch {
        // Scissor restore
    }

    try {
        if (typeof shared.scissorTest === 'boolean' && typeof renderer.setScissorTest === 'function') {
            renderer.setScissorTest(shared.scissorTest);
        }
    } catch {
        // Scissor test restore
    }

    try {
        // setPixelRatio() re-runs setSize() internally with current logical size
        if (typeof shared.pixelRatio === 'number' && typeof renderer.setPixelRatio === 'function') {
            renderer.setPixelRatio(shared.pixelRatio);
        }
        if (shared.size && typeof renderer.setSize === 'function') {
            renderer.setSize(shared.size.width, shared.size.height, false);
        }
        if (shared.autoClear !== undefined) {
            renderer.autoClear = shared.autoClear;
        }
    } catch {
        // Best effort renderer size / ratio restore
    }

    try {
        if (camera && typeof camera.clearViewOffset === 'function') {
            camera.clearViewOffset();
        }
    } catch {
        // Best effort camera view offset restore
    }
}

/**
 * Renders one tile of the full image with WebGLPathTracer and resolves with its
 * RGBA pixels.
 *
 * Progress is tracked through `pathTracer.samples` rather than a local call counter,
 * and pixels are read back only after the composite for the requested count has run.
 * Frames spent waiting for `pathTracer.isCompiling` push the watchdog deadline forward.
 * Everything borrowed from shared renderer/path-tracer/camera state is restored
 * deterministically before settlement.
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
 * @param {object} [options] Test seam: `{ stallTimeoutMs, now }` override watchdog budget and clock.
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
        // Captured before the first mutation so cleanup can restore everything
        const shared = captureSharedState(renderer, pathTracer, camera);
        const targetSamples = Math.max(1, Math.floor(samples) || 1);

        let settled = false;
        let rafId = null;
        let onAbort = null;

        const cleanupListeners = () => {
            if (abortSignal && onAbort && typeof abortSignal.removeEventListener === 'function') {
                abortSignal.removeEventListener('abort', onAbort);
                onAbort = null;
            }
            if (rafId !== null) {
                if (typeof cancelAnimationFrame === 'function') {
                    cancelAnimationFrame(rafId);
                }
                rafId = null;
            }
        };

        const finish = (error, pixels) => {
            if (settled) return;
            settled = true;
            cleanupListeners();
            restoreSharedState(renderer, pathTracer, camera, shared);
            if (error) {
                reject(error);
            } else {
                resolve(pixels);
            }
        };

        // Check if signal is already aborted before starting
        if (abortSignal?.aborted) {
            finish(new Error('Render aborted'));
            return;
        }

        // Register immediate abort listener so we never depend solely on the next animation frame
        if (abortSignal && typeof abortSignal.addEventListener === 'function') {
            onAbort = () => finish(new Error('Render aborted'));
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        // Setup runs inside promise executor so synchronous errors reject cleanly
        try {
            // Synchronize path tracer environment texture without color mutation
            ensurePathTracerEnvironment(pathTracer);

            // Configure path tracer for offline single-tile rendering
            pathTracer.rasterizeScene = false;
            pathTracer.renderDelay = 0;
            pathTracer.fadeDuration = 0;
            pathTracer.minSamples = 1;
            pathTracer.renderToCanvas = true;
            if (pathTracer.tiles && typeof pathTracer.tiles.set === 'function') {
                pathTracer.tiles.set(1, 1);
            }

            // 1:1 drawing-buffer to output pixel mapping
            if (typeof renderer.setPixelRatio === 'function') {
                renderer.setPixelRatio(1);
            }
            if (typeof renderer.setSize === 'function') {
                renderer.setSize(chunkWidth, chunkHeight, false);
            }

            // Frame the full-image camera onto this tile
            if (camera) {
                camera.aspect = totalWidth / totalHeight;
                if (typeof camera.setViewOffset === 'function') {
                    camera.setViewOffset(totalWidth, totalHeight, startX, startY, chunkWidth, chunkHeight);
                }
                if (typeof camera.updateProjectionMatrix === 'function') {
                    camera.updateProjectionMatrix();
                }
                if (typeof camera.updateMatrixWorld === 'function') {
                    camera.updateMatrixWorld(true);
                }
            }

            if (typeof pathTracer.updateCamera === 'function') {
                pathTracer.updateCamera();
            }

            if (typeof pathTracer.reset === 'function') {
                pathTracer.reset();
            }

            const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
            let lastProgressAt = now();

            const step = () => {
                if (settled) return;

                try {
                    if (abortSignal && abortSignal.aborted) {
                        finish(new Error('Render aborted'));
                        return;
                    }

                    if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
                        finish(new Error('WebGL context lost'));
                        return;
                    }

                    const currentTime = now();

                    // Compiling shaders blocks accumulation by design; advance watchdog deadline
                    if (pathTracer.isCompiling) {
                        lastProgressAt = currentTime;
                        if (!settled) {
                            rafId = requestAnimationFrame(step);
                        }
                        return;
                    }

                    const samplesBefore = pathTracer.samples;
                    pathTracer.renderSample();

                    if (typeof onProgress === 'function') {
                        onProgress({ samples: pathTracer.samples, maxSamples: targetSamples });
                    }

                    if (pathTracer.samples >= targetSamples) {
                        const pixels = new Uint8Array(chunkWidth * chunkHeight * 4);
                        if (gl) {
                            if (typeof gl.getParameter === 'function') {
                                shared.previousGlFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                            }
                            if (typeof gl.bindFramebuffer === 'function') {
                                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                            }
                            if (typeof gl.readPixels === 'function') {
                                gl.readPixels(0, 0, chunkWidth, chunkHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                            }
                        }
                        finish(null, pixels);
                        return;
                    }

                    if (pathTracer.samples > samplesBefore) {
                        lastProgressAt = currentTime;
                    } else if (currentTime - lastProgressAt > stallTimeoutMs) {
                        finish(new Error(`Path tracer stopped accumulating samples [chunk: ${chunkWidth}x${chunkHeight}, start: (${startX}, ${startY}), samples: ${pathTracer.samples}/${targetSamples}]`));
                        return;
                    }

                    if (!settled) {
                        rafId = requestAnimationFrame(step);
                    }
                } catch (error) {
                    finish(error);
                }
            };

            rafId = requestAnimationFrame(step);
        } catch (error) {
            finish(error);
        }
    });
}
