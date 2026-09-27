import React, { useRef, useState } from 'react';
import { useSearchParams } from "react-router-dom";
import { useRenderPipeline } from '../hooks/useRenderPipeline';

const JoinAfter = () => {
    const [searchParams] = useSearchParams();
    const roomID = searchParams.get("roomId");

    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("Initializing...");
    const [currentFrame, setCurrentFrame] = useState(0);
    const [chunkAssigned, setChunkAssigned] = useState("None");
    const [settings, setSettings] = useState({});

    const canvasRef = useRef(null);

    useRenderPipeline({
        role: 'worker',
        roomId: roomID,
        setStatus,
        setProgress,
        setCurrentFrame,
        setChunkAssigned,
        onSettingsReceived: setSettings,
        onTileReceived: (metadata, pixelBuffer) => {
            const task = { chunkWidth: metadata.chunkWidth, chunkHeight: metadata.chunkHeight };
            const canvas = canvasRef.current;
            if (!canvas || !pixelBuffer) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const tChunkW = parseInt(task.chunkWidth, 10) || chunkW;
            const tChunkH = parseInt(task.chunkHeight, 10) || chunkH;

            const raw = new Uint8ClampedArray(pixelBuffer);
            const flipped = new Uint8ClampedArray(raw.length);
            const rowSize = tChunkW * 4;

            for (let y = 0; y < tChunkH; y++) {
                const srcRow = (tChunkH - 1 - y) * rowSize;
                const dstRow = y * rowSize;
                flipped.set(raw.subarray(srcRow, srcRow + rowSize), dstRow);
            }

            for (let i = 3; i < flipped.length; i += 4) {
                flipped[i] = 255;
            }

            const imgData = new ImageData(flipped, tChunkW, tChunkH);
            ctx.putImageData(imgData, 0, 0);
        }
    });

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
