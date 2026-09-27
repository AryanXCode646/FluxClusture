import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { swarmClient } from '../services/SwarmClient';
import { loadGLB } from '../render/modelLoader';
import { upgradeSceneLights } from '../render/upgradeLights';
import { renderChunk } from '../render/gpuRenderer';
import { generateFileHash } from '../utils/helper';

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

export function useRenderPipeline({
    role,
    roomId,
    // Master specific config
    file,
    previewUrl,
    fileHash,
    config, // { width, height, fps, samples, noiseThreshold, animationIndex, startFrame, endFrame }
    // Callbacks
    setStatus,
    setProgress,
    setCurrentFrame,
    setChunkAssigned,
    onTileReceived,
    onFrameComplete,
    onSettingsReceived
}) {
    const isSceneReadyRef = useRef(false);
    const pendingChunksRef = useRef([]);

    const rendererRef = useRef(null);
    const pathTracerRef = useRef(null);
    const cameraRef = useRef(null);
    const sceneRef = useRef(null);
    const mixerRef = useRef(null);
    const currentRenderedFrameRef = useRef(role === 'master' ? (config?.startFrame || 0) : 0);
    const completedTilesRef = useRef(0);

    useEffect(() => {
        if (!roomId) return;

        let isSubscribed = true;
        const abortController = new AbortController();
        const chunkW = 128;
        const chunkH = 128;

        // 1. Initialize WebGL Canvas and Renderer (Off-DOM)
        const renderCanvas = document.createElement('canvas');
        rendererRef.current = new THREE.WebGLRenderer({ canvas: renderCanvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
        rendererRef.current.toneMapping = THREE.ACESFilmicToneMapping;
        rendererRef.current.toneMappingExposure = 1.0;

        pathTracerRef.current = new WebGLPathTracer(rendererRef.current);
        cameraRef.current = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);

        const processTask = async (task) => {
            if (!isSubscribed) return;
            console.log(`[useRenderPipeline] 🚀 Starting processTask for chunk:`, task.id || `${task.startX}_x_${task.startY}`);
            try {
                const fps = role === 'master' ? (config?.fps || 30) : (parseInt(swarmClient.fps, 10) || 30);
                const width = role === 'master' ? (config?.width || 1920) : parseInt(swarmClient.width, 10);
                const height = role === 'master' ? (config?.height || 1080) : parseInt(swarmClient.height, 10);
                const samples = role === 'master' ? (config?.samples || 1024) : parseInt(swarmClient.samples, 10);

                if (task.frame !== undefined && task.frame !== currentRenderedFrameRef.current) {
                    console.log(`[useRenderPipeline] 🎬 Frame changed from ${currentRenderedFrameRef.current} to ${task.frame}. Updating mixer and camera...`);
                    if (mixerRef.current) {
                        mixerRef.current.setTime(task.frame / fps);
                    }
                    syncCamera(sceneRef.current, cameraRef.current, width, height);
                    pathTracerRef.current.setScene(sceneRef.current, cameraRef.current);
                    currentRenderedFrameRef.current = task.frame;
                }

                const tChunkW = parseInt(task.chunkWidth, 10) || chunkW;
                const tChunkH = parseInt(task.chunkHeight, 10) || chunkH;

                console.log(`[useRenderPipeline] ⚙️ Calling gpuRenderer renderChunk for ${tChunkW}x${tChunkH} pixels...`);
                const pixels = await renderChunk(
                    rendererRef.current,
                    pathTracerRef.current,
                    cameraRef.current,
                    parseInt(task.startX, 10),
                    parseInt(task.startY, 10),
                    tChunkW,
                    tChunkH,
                    width,
                    height,
                    samples,
                    (progressData) => {
                        if (isSubscribed) {
                            if (role === 'worker' && progressData.maxSamples > 0 && setProgress) {
                                setProgress(progressData.samples / progressData.maxSamples);
                            }
                            if (role === 'worker' && progressData.pixels && onTileReceived) {
                                onTileReceived({ chunkWidth: tChunkW, chunkHeight: tChunkH }, progressData.pixels);
                            }
                        }
                    },
                    abortController.signal
                );

                console.log(`[useRenderPipeline] ✅ renderChunk completed for ${task.id || `${task.startX}_x_${task.startY}`}. Submitting tile...`);
                if (isSubscribed) {
                    if (role === 'worker' && onTileReceived) {
                        onTileReceived({ chunkWidth: tChunkW, chunkHeight: tChunkH }, pixels);
                    }
                    swarmClient.submitRenderedTile(task, pixels);
                }
            } catch (error) {
                if (error.message !== "Render aborted" && error.message !== "WebGL context lost") {
                    console.error("[useRenderPipeline] ❌ Render error:", error);
                } else {
                    console.log(`[useRenderPipeline] 🛑 Render aborted: ${error.message}`);
                }
            }
        };

        const setupScene = async (buffer) => {
            if (!isSubscribed) return;
            console.log("[useRenderPipeline] 🏗️ Setting up 3D scene from GLB buffer...");
            try {
                const gltf = await loadGLB(buffer.slice(0));
                console.log("[useRenderPipeline] 📦 GLB loaded successfully. Upgrading lights...");
                sceneRef.current = new THREE.Scene();
                sceneRef.current.add(gltf.scene);

                const giConfig = upgradeSceneLights(sceneRef.current);
                if (giConfig && giConfig.color !== undefined) {
                    let r, g, b;
                    if (giConfig.color.isColor) {
                        r = giConfig.color.r; g = giConfig.color.g; b = giConfig.color.b;
                    } else {
                        r = ((giConfig.color >> 16) & 255) / 255;
                        g = ((giConfig.color >> 8) & 255) / 255;
                        b = (giConfig.color & 255) / 255;
                    }
                    sceneRef.current.background = new THREE.Color(r, g, b);
                    sceneRef.current.backgroundIntensity = giConfig.intensity || 1.0;
                } else {
                    sceneRef.current.background = new THREE.Color(0x000000);
                }

                const animIndex = role === 'master' ? (config?.animationIndex || 0) : (parseInt(swarmClient.animationIndex, 10) || 0);
                if (gltf.animations && gltf.animations.length > 0) {
                    console.log(`[useRenderPipeline] 🎞️ Model has animations. Setting up AnimationMixer for index ${animIndex}...`);
                    mixerRef.current = new THREE.AnimationMixer(sceneRef.current);
                    if (gltf.animations[animIndex]) {
                        mixerRef.current.clipAction(gltf.animations[animIndex]).play();
                    }
                } else {
                    console.log("[useRenderPipeline] 🎞️ No animations found in GLB.");
                    mixerRef.current = null;
                }

                const fps = role === 'master' ? (config?.fps || 30) : (parseInt(swarmClient.fps, 10) || 30);
                const width = role === 'master' ? (config?.width || 1920) : parseInt(swarmClient.width, 10);
                const height = role === 'master' ? (config?.height || 1080) : parseInt(swarmClient.height, 10);
                
                const startFrame = role === 'master' ? (config?.startFrame || 0) : 0;
                if (mixerRef.current) {
                    mixerRef.current.setTime(startFrame / fps);
                }
                currentRenderedFrameRef.current = startFrame;

                console.log("[useRenderPipeline] 🎥 Syncing camera and passing scene to PathTracer...");
                syncCamera(sceneRef.current, cameraRef.current, width, height);
                pathTracerRef.current.setScene(sceneRef.current, cameraRef.current);
                isSceneReadyRef.current = true;
                console.log("[useRenderPipeline] 🎉 Scene setup complete! Ready to process chunks.");

                console.log(`[useRenderPipeline] 📝 Processing ${pendingChunksRef.current.length} pending chunks...`);
                pendingChunksRef.current.forEach(task => processTask(task));
                pendingChunksRef.current = [];

                if (role === 'worker') {
                    console.log("[useRenderPipeline] 🙋 Worker requesting initial tasks...");
                    swarmClient.socketManager.emit('REQUEST_TASK');
                }
            } catch (err) {
                console.error("[useRenderPipeline] ❌ Setup Scene error:", err);
                if (setStatus) setStatus("Error setting up scene.");
            }
        };

        swarmClient.on('status', (msg) => {
            if (!isSubscribed) return;
            console.log(`[useRenderPipeline] ℹ️ Status update: ${msg}`);
            if (setStatus) setStatus(msg);
        });

        swarmClient.on('newTask', (task) => {
            if (!isSubscribed) return;
            console.log(`[useRenderPipeline] 📥 Received newTask via socket:`, task.id || `${task.startX}_x_${task.startY}`);

            if (setCurrentFrame) setCurrentFrame(parseInt(task.frame, 10));
            if (setChunkAssigned) setChunkAssigned(task.id || `${task.startX}_x_${task.startY}`);
            if (role === 'worker' && setProgress) setProgress(0);

            let enrichedTask = task;
            if (role === 'master') {
                enrichedTask = {
                    ...task,
                    totalWidth: config.width,
                    totalHeight: config.height,
                    samples: config.samples,
                    noiseThreshold: config.noiseThreshold,
                    fps: config.fps
                };
            }

            if (!isSceneReadyRef.current) {
                console.log(`[useRenderPipeline] ⏳ Scene not ready yet. Queuing chunk ${enrichedTask.id || `${enrichedTask.startX}_x_${enrichedTask.startY}`}`);
                pendingChunksRef.current.push(enrichedTask);
            } else {
                processTask(enrichedTask);
            }
        });

        if (role === 'master') {
            swarmClient.on('frameComplete', (task) => {
                console.log(`[useRenderPipeline] 🎞️ Frame ${task.frame} marked as complete by SwarmClient!`);
                if (onFrameComplete) onFrameComplete(task);
            });

            swarmClient.on('tileReceived', ({ metadata, pixelBuffer }) => {
                if (!isSubscribed) return;
                
                swarmClient.socketManager.emit('ACK_TILE', { id: metadata.taskId, task: { frame: metadata.frame } });
                
                if (onTileReceived) onTileReceived(metadata, pixelBuffer);

                completedTilesRef.current += 1;
                const totalFrames = Math.max(1, config.endFrame - config.startFrame + 1);
                const cols = Math.ceil(config.width / 64);
                const rows = Math.ceil(config.height / 64);
                const totalTiles = totalFrames * cols * rows;

                if (totalTiles > 0 && setProgress) {
                    const pct = Math.min(1, completedTilesRef.current / totalTiles);
                    setProgress(pct);
                }
            });

            async function initMaster() {
                let buffer = null;
                if (file && typeof file.arrayBuffer === 'function') {
                    buffer = await file.arrayBuffer();
                } else if (previewUrl) {
                    const response = await fetch(previewUrl);
                    buffer = await response.arrayBuffer();
                }
                if (!isSubscribed || !buffer) return;

                swarmClient.glbBuffer = buffer;
                await setupScene(buffer);

                swarmClient.joinAsMaster(roomId);
                
                swarmClient.setRenderSetting(
                    swarmClient.socketManager.id,
                    fileHash,
                    config.width,
                    config.height,
                    config.noiseThreshold,
                    config.samples,
                    config.animationIndex,
                    config.fps
                );
        
                swarmClient.startRenderJob(
                    roomId,
                    config.startFrame,
                    config.endFrame,
                    config.width,
                    config.height,
                    config.fps,
                    fileHash,
                    config.samples,
                    config.noiseThreshold,
                    config.animationIndex
                );
            }
            initMaster();
        } 
        else if (role === 'worker') {
            swarmClient.on('fileReady', async () => {
                if (!isSubscribed) return;

                if (onSettingsReceived) {
                    onSettingsReceived({
                        samples: parseInt(swarmClient.samples, 10),
                        noiseThreshold: parseFloat(swarmClient.noise),
                        fps: parseInt(swarmClient.fps, 10),
                        width: parseInt(swarmClient.width, 10),
                        height: parseInt(swarmClient.height, 10),
                        animationIndex: parseInt(swarmClient.animationIndex, 10)
                    });
                }

                if (swarmClient.glbBuffer) {
                    if (setStatus) setStatus("Verifying GLB file...");
                    const hash = await generateFileHash(swarmClient.glbBuffer);

                    if (hash !== swarmClient.glbHash) {
                        console.error("GLB hash mismatch! Expected:", swarmClient.glbHash, "Got:", hash);
                        if (setStatus) setStatus("Hash mismatch. Requesting GLB again...");
                        swarmClient.socketManager.emit('REQUEST_SEEDER', { roomId });
                        return;
                    }

                    if (setStatus) setStatus("GLB verified. Setting up scene...");
                    await setupScene(swarmClient.glbBuffer);
                }
            });

            swarmClient.joinAsWorker(roomId);
        }

        return () => {
            isSubscribed = false;
            abortController.abort();
            
            if (rendererRef.current) {
                rendererRef.current.dispose();
                rendererRef.current.forceContextLoss();
                rendererRef.current = null;
            }
            pathTracerRef.current = null;
            
            if (swarmClient.socketManager.socket) {
                swarmClient.socketManager.socket.disconnect();
            }
        };
    }, [roomId, role, file, fileHash, previewUrl, config]);
}
