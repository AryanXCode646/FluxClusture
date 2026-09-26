import React, { useEffect, useRef, useState } from 'react'
import { useSearchParams } from "react-router-dom";
import { swarmClient } from '../services/SwarmClient';
import RenderWorker from '../render/renderWorker.js?worker';
import { generateFileHash } from '../utils/helper.js';

const JoinAfter = () => {
    const [searchParams] = useSearchParams();
    const roomID = searchParams.get("roomId");

    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("Initializing...");
    const [currentFrame, setCurrentFrame] = useState(0);
    const [chunkAssigned, setChunkAssigned] = useState("None");
    const [settings, setSettings] = useState({});

    const canvasRef = useRef(null);
    const workerRef = useRef(null);
    const isSceneReadyRef = useRef(false);
    const pendingChunksRef = useRef([]);


    const chunkW = 256;
    const chunkH = 256;

    useEffect(() => {
        if (!roomID) return;

        let isSubscribed = true;

        // 1. Initialize Web Worker
        workerRef.current = new RenderWorker();

        // Let the worker use its own internal OffscreenCanvas
        workerRef.current.postMessage({ type: 'INIT_CANVAS' });

        // 2. Setup Worker Message Handler
        workerRef.current.onmessage = (event) => {
            if (!isSubscribed) return;
            const data = event.data;

            const drawPixelsToCanvas = (pixels) => {
                if (!canvasRef.current || !pixels) return;
                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) return;

                const raw = new Uint8ClampedArray(pixels);
                const flipped = new Uint8ClampedArray(raw.length);
                const rowSize = chunkW * 4;

                for (let y = 0; y < chunkH; y++) {
                    const srcRow = (chunkH - 1 - y) * rowSize;
                    const dstRow = y * rowSize;
                    flipped.set(raw.subarray(srcRow, srcRow + rowSize), dstRow);
                }

                for (let i = 3; i < flipped.length; i += 4) {
                    flipped[i] = 255;
                }

                const imgData = new ImageData(flipped, chunkW, chunkH);
                ctx.putImageData(imgData, 0, 0);
            };

            if (data.type === 'CHUNK_PROGRESS') {
                if (data.maxSamples > 0) {
                    setProgress(data.samples / data.maxSamples);
                }
                if (data.pixels) {
                    drawPixelsToCanvas(data.pixels);
                }
            }

            if (data.type === 'CHUNK_FINISHED') {
                const { pixels, task } = data;
                drawPixelsToCanvas(pixels);
                // Hand the final pixel array to SwarmClient to blast over WebRTC
                swarmClient.submitRenderedTile(task, pixels);
            }

            if (data.type === 'ERROR') {
                console.error("[RenderWorker Error]:", data.message);
            }

            if (data.type === 'SCENE_READY') {
                isSceneReadyRef.current = true;
                pendingChunksRef.current.forEach(task => {
                    workerRef.current.postMessage({
                        type: 'RENDER_CHUNK',
                        taskId: task.id,
                        task: task,
                        startX: parseInt(task.startX, 10),
                        startY: parseInt(task.startY, 10),
                        totalWidth: parseInt(swarmClient.width, 10),
                        totalHeight: parseInt(swarmClient.height, 10),
                        frame: parseInt(task.frame, 10),
                        samples: parseInt(swarmClient.samples, 10),
                        noiseThreshold: parseFloat(swarmClient.noise),
                        fps: parseInt(swarmClient.fps, 10),
                        chunkWidth: chunkW,
                        chunkHeight: chunkH,
                    });
                });
                pendingChunksRef.current = [];
            }
        };

        // 3. Setup SwarmClient Listeners
        swarmClient.on('status', (msg) => {
            if (isSubscribed) setStatus(msg);
        });

        swarmClient.on('fileReady', async () => {
            if (!isSubscribed) return;

            setSettings({
                samples: parseInt(swarmClient.samples, 10),
                noiseThreshold: parseFloat(swarmClient.noise),
                fps: parseInt(swarmClient.fps, 10),
                width: parseInt(swarmClient.width, 10),
                height: parseInt(swarmClient.height, 10),
                animationIndex: parseInt(swarmClient.animationIndex, 10)
            });

            if (swarmClient.glbBuffer) {
                setStatus("Verifying GLB file...");
                const hash = await generateFileHash(swarmClient.glbBuffer);

                if (hash !== swarmClient.glbHash) {
                    console.error("GLB hash mismatch! Expected:", swarmClient.glbHash, "Got:", hash);
                    setStatus("Hash mismatch. Requesting GLB again...");
                    swarmClient.socketManager.emit('REQUEST_SEEDER', { roomId: roomID });
                    return;
                }

                setStatus("GLB verified. Setting up scene...");

                workerRef.current.postMessage({
                    type: 'SETUP_SCENE',
                    fileData: swarmClient.glbBuffer.slice(0),
                    animationIndex: parseInt(swarmClient.animationIndex, 10) || 0,
                    fps: parseInt(swarmClient.fps, 10) || 30,
                    totalWidth: parseInt(swarmClient.width, 10),
                    totalHeight: parseInt(swarmClient.height, 10),
                    frame: 0
                });

                // Start taking rendering jobs
                swarmClient.socketManager.emit('REQUEST_TASK');
            }
        });

        swarmClient.on('newTask', (task) => {
            if (!isSubscribed) return;

            setCurrentFrame(parseInt(task.frame, 10));
            setChunkAssigned(task.id || `${task.startX}_x_${task.startY}`);
            setProgress(0); // reset progress

            if (!isSceneReadyRef.current) {
                pendingChunksRef.current.push(task);
            } else {
                workerRef.current.postMessage({
                    type: 'RENDER_CHUNK',
                    taskId: task.id,
                    task: task,
                    startX: parseInt(task.startX, 10),
                    startY: parseInt(task.startY, 10),
                    totalWidth: parseInt(swarmClient.width, 10),
                    totalHeight: parseInt(swarmClient.height, 10),
                    frame: parseInt(task.frame, 10),
                    samples: parseInt(swarmClient.samples, 10),
                    noiseThreshold: parseFloat(swarmClient.noise),
                    fps: parseInt(swarmClient.fps, 10),
                    chunkWidth: chunkW,
                    chunkHeight: chunkH,
                });
            }
        });

        // 4. Connect to Swarm
        swarmClient.joinAsWorker(roomID);

        return () => {
            isSubscribed = false;
            if (workerRef.current) {
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
    }, [roomID]);

    return (
        <div className='w-[80%] h-2/3 flex justify-between flex-col geist-mono-regular'>
            <div className='flex justify-between items-center text-sm'>
                <div className='w-1/3'>
                    <div className='geist-mono-bold mb-10 text-white'>
                        room : {roomID}
                    </div>

                    <div className='text-xs text-gray-400 mb-4'>Status: {status}</div>

                    <div className='text-[#606060] mb-10'>
                        <p>Rendering node active</p>
                        <p>Frame: {currentFrame}</p>
                        <p>Chunk Assigned: {chunkAssigned}</p>
                    </div>

                    <div className='border w-full p-4'>
                        <h3 className='text-white mb-3'>Render Settings</h3>
                        <div className='grid grid-cols-2 gap-2'>
                            <p className='text-[#606060] text-xs'>
                                Resolution: {settings.width && settings.height ? `${settings.width}x${settings.height}` : '-'}
                            </p>
                            <p className='text-[#606060] text-xs'>
                                Samples: {settings.samples || '-'}
                            </p>
                            <p className='text-[#606060] text-xs'>
                                Noise Threshold: {settings.noiseThreshold || '-'}
                            </p>
                            <p className='text-[#606060] text-xs'>
                                FPS: {settings.fps || '-'}
                            </p>
                            <p className='text-[#606060] text-xs'>
                                Animation Index: {settings.animationIndex !== undefined ? settings.animationIndex : '-'}
                            </p>
                        </div>
                    </div>
                </div>

                <div className='aspect-square w-5/16 bg-[#1a1a1a] flex items-center justify-center overflow-hidden border border-gray-800 rounded'>
                    {/* 
                        Size the internal canvas buffer to exactly 64x64 so it matches the chunk, 
                        and let CSS scale it up to fill the container.
                        'imageRendering: pixelated' keeps it sharp if you want to see the pixels.
                    */}
                    <canvas
                        ref={canvasRef}
                        width={64}
                        height={64}
                        className="w-full h-full"
                    />
                </div>
            </div>

            <div className='w-full flex justify-center mt-6'>
                <div className='w-full border h-7'>
                    <div
                        className='h-full bg-white text-black p-1 flex items-center justify-center transition-all duration-150 text-xs font-bold'
                        style={{ width: `${Math.max(2, progress * 100)}%` }}
                    >
                        {(progress * 100).toFixed(1)}%
                    </div>
                </div>
            </div>
        </div>
    )
}

export default JoinAfter
