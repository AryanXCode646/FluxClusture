import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { loadGLB } from './modelLoader.js';
import { upgradeSceneLights } from './upgradeLights.js';
import { renderChunk } from './gpuRenderer.js';

let renderer = null;
let pathTracer = null;
let camera = null;
let currentScene = null;
let mixer = null;
let currentRenderedFrame = 0;

/**
 * Synchronizes the path tracer camera with the GLB camera, 
 * or falls back to a reasonable default view.
 */
function syncCamera(scene, renderCamera, width, height) {
    if (!renderCamera) return;
    const glbCamera = scene.getObjectByProperty('isPerspectiveCamera', true);
    
    if (glbCamera) {
        scene.updateMatrixWorld(true);
        glbCamera.matrixWorld.decompose(renderCamera.position, renderCamera.quaternion, renderCamera.scale);
        renderCamera.fov = glbCamera.fov;
        renderCamera.near = glbCamera.near;
        renderCamera.far = glbCamera.far;
    } else {
        // Fallback: auto-fit camera to scene
        const box = new THREE.Box3().setFromObject(scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
            const fov = renderCamera.fov * (Math.PI / 180);
            let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
            cameraZ *= 1.5; 
            renderCamera.position.set(center.x, center.y, center.z + cameraZ);
            renderCamera.lookAt(center);
        }
    }
    
    renderCamera.aspect = width / height;
    renderCamera.updateProjectionMatrix();
}

self.onmessage = async (event) => {
    const data = event.data;

    try {
        if (data.type === 'INIT_CANVAS') {
            const canvas = data.canvas || new OffscreenCanvas(64, 64);
            
            // CRITICAL: preserveDrawingBuffer must be true to read pixels asynchronously
            renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.0;

            pathTracer = new WebGLPathTracer(renderer);
            
            camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
            self.postMessage({ type: 'CANVAS_INITIALIZED' });
        }

        if (data.type === 'SETUP_SCENE') {
            const gltf = await loadGLB(data.fileData);

            currentScene = new THREE.Scene();
            currentScene.add(gltf.scene);

            // Upgrade placeholder lights and apply background
            const giConfig = upgradeSceneLights(currentScene);
            if (giConfig && giConfig.color !== undefined) {
                let r, g, b;
                if (giConfig.color.isColor) {
                    r = giConfig.color.r; g = giConfig.color.g; b = giConfig.color.b;
                } else {
                    r = ((giConfig.color >> 16) & 255) / 255;
                    g = ((giConfig.color >> 8) & 255) / 255;
                    b = (giConfig.color & 255) / 255;
                }
                currentScene.background = new THREE.Color(r, g, b);
                currentScene.backgroundIntensity = giConfig.intensity || 1.0;
            } else {
                currentScene.background = new THREE.Color(0x000000);
            }

            // Setup animations if present
            if (gltf.animations && gltf.animations.length > 0) {
                mixer = new THREE.AnimationMixer(currentScene);
                const animIndex = data.animationIndex || 0;
                if (gltf.animations[animIndex]) {
                    mixer.clipAction(gltf.animations[animIndex]).play();
                }
            } else {
                mixer = null;
            }

            const initialFrame = data.frame || 0;
            const fps = data.fps || 30;
            if (mixer) {
                mixer.setTime(initialFrame / fps);
            }
            currentRenderedFrame = initialFrame;

            const width = data.totalWidth || 1920;
            const height = data.totalHeight || 1080;

            syncCamera(currentScene, camera, width, height);
            
            // Build BVH and initialize path tracer
            pathTracer.setScene(currentScene, camera);

            self.postMessage({ type: 'SCENE_READY' });
        }

        if (data.type === 'RENDER_CHUNK') {
            if (!renderer || !pathTracer || !currentScene || !camera) {
                throw new Error("Worker not fully initialized for rendering.");
            }

            // Handle frame changes for animations
            if (data.frame !== undefined && data.frame !== currentRenderedFrame) {
                if (mixer) {
                    mixer.setTime(data.frame / (data.fps || 30));
                }
                syncCamera(currentScene, camera, data.totalWidth, data.totalHeight);
                pathTracer.setScene(currentScene, camera);
                currentRenderedFrame = data.frame;
            }

            // Make sure chunk dimensions fall back reasonably if not perfectly specified
            const chunkWidth = data.chunkWidth || 64;
            const chunkHeight = data.chunkHeight || 64;

            const finalPixels = await renderChunk(
                renderer,
                pathTracer,
                camera,
                data.startX,
                data.startY,
                chunkWidth,
                chunkHeight,
                data.totalWidth,
                data.totalHeight,
                data.samples || 50,
                (progressData) => {
                    self.postMessage({
                        type: 'CHUNK_PROGRESS',
                        taskId: data.taskId,
                        ...progressData
                    });
                }
            );

            // Zero-Copy Transfer
            self.postMessage(
                { type: 'CHUNK_FINISHED', taskId: data.taskId, task: data.task, pixels: finalPixels },
                [finalPixels.buffer]
            );
        }
        
        if (data.type === 'DISPOSE') {
            if (renderer) {
                renderer.dispose();
                renderer.forceContextLoss();
            }
            renderer = null;
            pathTracer = null;
            return;
        }

    } catch (error) {
        console.error("[RenderWorker Error]:", error);
        self.postMessage({ type: 'ERROR', message: error?.message || String(error) });
    }
};