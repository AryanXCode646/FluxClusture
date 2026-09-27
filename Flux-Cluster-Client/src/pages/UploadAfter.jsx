import React, { useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { encodeFramesToMP4 } from '../render/videoExporter';
import { useRenderPipeline } from '../hooks/useRenderPipeline';

const UploadAfter = () => {
    const location = useLocation();
    const config = location.state || {};

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
    const [chunkAssigned, setChunkAssigned] = useState("idle");

    const containerCanvas = useRef(null);
    const canvasRef = useRef(null);
    const completedFramesMap = useRef(new Map());

    function drawTileToCanvas(metadata, pixelBuffer) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        const tChunkW = parseInt(metadata.chunkWidth, 10) || 128;
        const tChunkH = parseInt(metadata.chunkHeight, 10) || 128;

        const raw = new Uint8ClampedArray(pixelBuffer);
        const flipped = new Uint8ClampedArray(raw.length);
        const rowSize = tChunkW * 4;

        // Invert vertically since WebGL readRenderTargetPixels has bottom-left origin
        for (let y = 0; y < tChunkH; y++) {
            const srcRow = (tChunkH - 1 - y) * rowSize;
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

        const imgData = new ImageData(flipped, tChunkW, tChunkH);
        const drawWidth = Math.min(tChunkW, width - metadata.startX);
        const drawHeight = Math.min(tChunkH, height - metadata.startY);
        ctx.putImageData(imgData, metadata.startX, metadata.startY, 0, 0, drawWidth, drawHeight);
    }

    const configObject = React.useMemo(() => ({
        width, height, fps, samples, noiseThreshold, animationIndex, startFrame, endFrame
    }), [width, height, fps, samples, noiseThreshold, animationIndex, startFrame, endFrame]);

    useRenderPipeline({
        role: 'master',
        roomId,
        file,
        previewUrl,
        fileHash,
        config: configObject,
        setStatus,
        setProgress,
        setCurrentFrame,
        setChunkAssigned,
        onFrameComplete: (task) => {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const fullFrameData = ctx.getImageData(0, 0, width, height);
            completedFramesMap.current.set(task.frame, fullFrameData);
            console.log(`Successfully saved Frame ${task.frame} to memory.`);
        },
        onTileReceived: (metadata, pixelBuffer) => {
            drawTileToCanvas(metadata, pixelBuffer);
        }
    });

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
