import * as THREE from 'three';

/**
 * Minimal GPU Renderer for rendering arbitrary-sized chunks via WebGLPathTracer.
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
        try {
            // 1. Resize renderer to match the exact chunk dimensions
            renderer.setSize(chunkWidth, chunkHeight, false);

            // 2. Configure camera to render only this specific region of the total image
            camera.aspect = totalWidth / totalHeight;
            camera.setViewOffset(totalWidth, totalHeight, startX, startY, chunkWidth, chunkHeight);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld(true);

            // 3. Update the path tracer internal state and clear old accumulation data
            pathTracer.updateCamera();
            pathTracer.reset();

            // 4. Accumulate samples in batches to keep the main thread from freezing completely
            let totalSamples = 0;
            
            function renderLoop() {
                if (abortSignal?.aborted) {
                    reject(new Error("Render aborted"));
                    return;
                }

                const gl = renderer.getContext();
                if (gl.isContextLost()) {
                    reject(new Error("WebGL context lost"));
                    return;
                }

                if (totalSamples < samples) {
                    // Render 5 samples per batch
                    const batchSize = Math.min(5, samples - totalSamples);
                    for (let i = 0; i < batchSize; i++) {
                        pathTracer.renderSample();
                        totalSamples++;
                    }

                    if (typeof onProgress === 'function') {
                        onProgress({ samples: totalSamples, maxSamples: samples });
                    }

                    requestAnimationFrame(renderLoop);
                } else {
                    // 5. Read the final pixels from the tone-mapped canvas framebuffer
                    const bufferSize = chunkWidth * chunkHeight * 4;
                    const pixels = new Uint8Array(bufferSize);

                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.readPixels(0, 0, chunkWidth, chunkHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

                    // 6. Cleanup camera offset so it doesn't mess up future non-chunk operations
                    camera.clearViewOffset();

                    resolve(pixels);
                }
            }
            
            requestAnimationFrame(renderLoop);
        } catch (err) {
            reject(err);
        }
    });
}