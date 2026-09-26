import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { swarmClient } from '../services/SwarmClient';
import RenderWorker from '../render/renderWorker.js?worker';
import { encodeFramesToMP4 } from '../render/videoExporter';

const UploadAfter = () => {
    const location = useLocation();
    const config = location.state || {};

    const chunkW = 256;
    const chunkH = 256;

    const {
        roomId = '',
        file = null,
        fileHash = null,
        previewUrl = null
    } = config;
    const width = parseInt(config.width || 1920, 10);
    const height = parseInt(config.height || 1080, 10);
    const fps = parseInt(config.fps || 30, 10);
    const samples = parseInt(config.samples || 1024, 10);
    const noiseThreshold = parseFloat(config.noiseThreshold || 0.1);
    const animationIndex = parseInt(config.animationIndex || 0, 10);

    const startFrame = parseInt(config.startFrame || 0, 10);
    const endFrame = parseInt(config.endFrame || 0, 10);

    const [status, setStatus] = useState("Initializing...");
    const [progress, setProgress] = useState(0);
    const [currentFrame, setCurrentFrame] = useState(startFrame);
    const currentFrameRef = useRef(startFrame);
    const [chunkAssigned, setChunkAssigned] = useState("idle");

    const containerCanvas = useRef(null);
    const canvasRef = useRef(null);
    const workerRef = useRef(null);
    const completedTilesRef = useRef(0);
    const isSceneReadyRef = useRef(false);
    const pendingChunksRef = useRef([]);

    const totalFrames = Math.max(1, endFrame - startFrame + 1);
    const cols = Math.ceil(width / 64);
    const rows = Math.ceil(height / 64);
    const totalTiles = totalFrames * cols * rows;

    const completedFramesMap = useRef(new Map());

    function drawTileToCanvas(metadata, pixelBuffer) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;


        const raw = new Uint8ClampedArray(pixelBuffer);
        const flipped = new Uint8ClampedArray(raw.length);
        const rowSize = chunkW * 4;

        // Invert vertically since WebGL readRenderTargetPixels has bottom-left origin
        for (let y = 0; y < chunkH; y++) {
            const srcRow = (chunkH - 1 - y) * rowSize;
            const dstRow = y * rowSize;
            flipped.set(raw.subarray(srcRow, srcRow + rowSize), dstRow);
        }

        // Force alpha to 255 so transparent backgrounds don't render as invisible
        let maxR = 0, maxG = 0, maxB = 0;
        for (let i = 0; i < flipped.length; i += 4) {
            flipped[i + 3] = 255;
            if (flipped[i] > maxR) maxR = flipped[i];
            if (flipped[i + 1] > maxG) maxG = flipped[i + 1];
            if (flipped[i + 2] > maxB) maxB = flipped[i + 2];
        }

        console.log(`[Pipeline] D. Main thread drawing tile to canvas at ${metadata.startX}, ${metadata.startY} | Max RGB: [${maxR}, ${maxG}, ${maxB}]`);

        const imgData = new ImageData(flipped, chunkW, chunkH);
        const drawWidth = Math.min(chunkW, width - metadata.startX);
        const drawHeight = Math.min(chunkH, height - metadata.startY);
        ctx.putImageData(imgData, metadata.startX, metadata.startY, 0, 0, drawWidth, drawHeight);
    }

    useEffect(() => {
        if (!roomId) return;

        let isSubscribed = true;

        // 1. Initialize background RenderWorker
        const worker = new RenderWorker();
        workerRef.current = worker;

        try {
            const offscreen = new OffscreenCanvas(chunkW, chunkH);
            worker.postMessage({ type: 'INIT_CANVAS', canvas: offscreen }, [offscreen]);
        } catch (err) {
            console.warn("Could not transfer OffscreenCanvas, letting worker self-initialize:", err);
            worker.postMessage({ type: 'INIT_CANVAS' });
        }

        // 2. Load GLB ArrayBuffer into SwarmClient & RenderWorker
        async function initModel() {
            try {
                let buffer = null;
                if (file && typeof file.arrayBuffer === 'function') {
                    buffer = await file.arrayBuffer();
                } else if (previewUrl) {
                    const response = await fetch(previewUrl);
                    buffer = await response.arrayBuffer();
                }

                if (!isSubscribed) return;

                if (buffer) {
                    // Seed file to peers over WebRTC
                    swarmClient.glbBuffer = buffer;

                    // Send a copy to the local worker
                    worker.postMessage({
                        type: 'SETUP_SCENE',
                        fileData: buffer.slice(0),
                        animationIndex: animationIndex ?? 0,
                        fps: fps ?? 30,
                        totalWidth: width,
                        totalHeight: height,
                        frame: startFrame ?? 0
                    });
                }
            } catch (err) {
                console.error("Failed to load GLB file into worker:", err);
            }
        }

        initModel();

        // 3. Listen to messages from the background render worker
        worker.onmessage = (event) => {
            const data = event.data;
            if (data.type === 'CHUNK_FINISHED') {
                const { task, pixels } = data;
                if (task && pixels) {
                    swarmClient.submitRenderedTile(task, pixels);
                }
            } else if (data.type === 'SCENE_READY') {
                isSceneReadyRef.current = true;

                // Flush any queued chunks that arrived before the scene was ready
                pendingChunksRef.current.forEach(enrichedTask => {
                    worker.postMessage({
                        type: 'RENDER_CHUNK',
                        taskId: enrichedTask.id,
                        task: enrichedTask,
                        startX: enrichedTask.startX,
                        startY: enrichedTask.startY,
                        totalWidth: width,
                        totalHeight: height,
                        frame: enrichedTask.frame,
                        fps: fps,
                        samples: samples,
                        noiseThreshold: noiseThreshold,
                        chunkWidth: chunkW,
                        chunkHeight: chunkH,
                    });
                });
                pendingChunksRef.current = [];
            } else if (data.type === 'ERROR') {
                console.error("[RenderWorker Error]:", data.message);
            }
        };

        // 4. Setup SwarmClient callbacks
        swarmClient.on('status', (msg) => {
            if (!isSubscribed) return;
            setStatus(msg);
        });


        swarmClient.on('frameComplete', (task) => {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            // Extract the fully painted frame from the canvas
            const fullFrameData = ctx.getImageData(0, 0, width, height);

            // Save it in our map
            completedFramesMap.current.set(task.frame, fullFrameData);
            console.log(`Successfully saved Frame ${task.frame} to memory.`);
        })

        swarmClient.on('newTask', (task) => {
            if (!isSubscribed) return;

            if (currentFrameRef.current !== task.frame) {
                currentFrameRef.current = task.frame;
                const canvas = canvasRef.current;
                if (canvas) {
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    if (ctx) {
                        ctx.fillStyle = 'white';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                    }
                }
            }

            setCurrentFrame(task.frame);
            setChunkAssigned(task.id || `${task.startX}_x_${task.startY}`);

            const enrichedTask = {
                ...task,
                totalWidth: width,
                totalHeight: height,
                samples: samples,
                noiseThreshold: noiseThreshold,
                fps: fps
            };

            // Queue chunks if scene is not ready yet, or post immediately
            if (!isSceneReadyRef.current) {
                pendingChunksRef.current.push(enrichedTask);
            } else {
                worker.postMessage({
                    type: 'RENDER_CHUNK',
                    taskId: task.id,
                    task: enrichedTask,
                    startX: task.startX,
                    startY: task.startY,
                    totalWidth: width,
                    totalHeight: height,
                    frame: enrichedTask.frame,
                    fps: fps,
                    samples: samples,
                    noiseThreshold: noiseThreshold,
                    chunkWidth: chunkW,
                    chunkHeight: chunkH,
                });
            }
        });

        swarmClient.on('tileReceived', ({ metadata, pixelBuffer }) => {
            if (!isSubscribed) return;
            console.log("renderChunk recieved : ", metadata);

            swarmClient.socketManager.emit('ACK_TILE', { id: metadata.taskId, task: { frame: metadata.frame } });
            drawTileToCanvas(metadata, pixelBuffer);



            completedTilesRef.current += 1;
            if (totalTiles > 0) {
                const pct = Math.min(1, completedTilesRef.current / totalTiles);
                setProgress(pct);
            }
        });

        // 5. Connect and join as Master node
        swarmClient.joinAsMaster(roomId);
        console.log("joined to server as master")

        swarmClient.setRenderSetting(
            swarmClient.socketManager.id,
            fileHash,
            width,
            height,
            noiseThreshold,
            samples,
            animationIndex,
            fps
        );

        swarmClient.startRenderJob(
            roomId,
            startFrame,
            endFrame,
            width,
            height,
            fps,
            fileHash,
            samples,
            noiseThreshold,
            animationIndex
        );

        // 6. Cleanup on unmount
        return () => {
            isSubscribed = false;
            if (workerRef.current) {
                // Send DISPOSE so the worker cleanly destroys the WebGL context before termination
                workerRef.current.postMessage({ type: 'DISPOSE' });
                setTimeout(() => {
                    if (workerRef.current) {
                        workerRef.current.terminate();
                        workerRef.current = null;
                    }
                }, 100);
            }
            if (swarmClient.socketManager.socket) {
                swarmClient.socketManager.socket.disconnect();
            }
        };
    }, [roomId, file, fileHash, previewUrl, startFrame, endFrame, fps, width, height, samples, noiseThreshold, animationIndex]);

    const canvasRatio = width / height;
    const containerRatio = 16 / 9;
    const isWider = canvasRatio > containerRatio;


    const handleExportVideo = async () => {
        setStatus("Encoding video... Please wait.");

        // Sort frames sequentially in case they finished out of order
        const orderedFrames = [];
        for (let f = startFrame; f <= endFrame; f++) {
            if (completedFramesMap.current.has(f)) {
                orderedFrames.push(completedFramesMap.current.get(f));
            } else {
                console.warn(`Missing frame ${f}, video might stutter.`);
            }
        }

        try {
            const videoBlob = await encodeFramesToMP4(orderedFrames, width, height, fps);

            // Create a download trigger
            const downloadUrl = URL.createObjectURL(videoBlob);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = `FluxCluster_Render_${roomId}.mp4`;
            link.click();
            URL.revokeObjectURL(downloadUrl);

            setStatus("Video downloaded!");
        } catch (error) {
            console.error("Video export failed:", error);
            setStatus("Export failed.");
        }
    };

    return (
        <div className='w-[84%] h-[90%] geist-mono-regular'>
            <div className='text-sm text-[#606060]'>
                <div className='flex justify-between items-center mb-2'>
                    <p className='text-white'>Room : {roomId}</p>
                    <span className='text-xs text-gray-400'>Status: {status}</span>
                </div>
                <div className='mb-2'>
                    <div className='flex justify-between'>
                        <p>Rendering : {file?.name || 'Model'}</p>
                        <p>/ Frame : {currentFrame}/{endFrame}</p>
                        <p>/ Chunk Assigned : {chunkAssigned}</p>
                    </div>

                    <p>samples: {samples} noise threshold: {noiseThreshold}</p>
                </div>
            </div>
            <div
                ref={containerCanvas}
                className="w-full mb-4 aspect-video items-center flex justify-center overflow-hidden"
            >
                <canvas
                    ref={canvasRef}
                    width={width}
                    height={height}
                    className=""
                    style={{
                        width: isWider ? '100%' : 'auto',
                        height: isWider ? 'auto' : '100%',
                        aspectRatio: `${width} / ${height}`
                    }}
                />
            </div>
            <div className='w-full flex justify-center'>

                {(1 - progress) ?
                    <div className='w-[90%] border h-7 flex items-center'>
                        <div
                            className='h-full bg-white text-black p-1 flex items-center justify-center transition-all duration-150 text-xs font-bold'
                            style={{ width: `${Math.max(2, progress * 100)}%` }}
                        >
                            {(progress * 100).toFixed(1)}%
                        </div>
                    </div>
                    :
                    <button className='h-full aspect-5/1 bg-none border border-white text-white' onClick={handleExportVideo}>
                        Export video
                    </button>
                }

            </div>
        </div>
    );
};

export default UploadAfter;
