import React, { useState, useEffect } from 'react'
import UploadBox from '../components/UploadBox';
import * as THREE from 'three'
import { loadGLB } from '../render/modelLoader.js';
import { useNavigate } from "react-router-dom";
import { generateSecureShortId, generateFileHash} from '../utils/helper.js'


const UploadBefore = () => {

    const navigate = useNavigate();

    const [file, setFile] = useState(null);
    const [loading, setLoading] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);

    const [glbHash, setGlbHash] = useState(null);

    const [roomId, setRoomId] = useState(null);
    

    const [Animations, setAnimations] = useState([])
    const [animDurations, setAnimDurations] = useState([])
    const [Fps, setFps] = useState(30)
    const [RenderAnimation, setRenderAnimation] = useState(0)
    const [samples, setSamples] = useState(1024)
    const [noiseThreshold, setNoiseThreshold] = useState(0.1)

    const [width, setWidth] = useState(1920);
    const [height, setHeight] = useState(1080);

    const [min, setMin] = useState(0);
    const [max, setMax] = useState(120);

    const [start, setStart] = useState(min);
    const [end, setEnd] = useState(max);

    useEffect(() => {
        async function extractMetadata() {
            if (file) {
                try {
                    // Convert the raw File object directly into an ArrayBuffer
                    const buffer = await file.arrayBuffer();

                    const hash = await generateFileHash(buffer);
                    setGlbHash(hash);

                    setRoomId(generateSecureShortId())

                    // Pass it to your robust loader (which handles Draco if needed)
                    const gltf = await loadGLB(buffer);

                    if (gltf.animations && gltf.animations.length > 0) {
                        const names = gltf.animations.map((anim, i) => anim.name || `Animation ${i}`);
                        const durations = gltf.animations.map(anim => anim.duration);

                        setAnimations(names);
                        setAnimDurations(durations);
                        setRenderAnimation(0);
                    } else {
                        setAnimations([]);
                        setAnimDurations([]);
                    }
                } catch (error) {
                    console.error("Error parsing GLB metadata:", error);
                }
            }
        }

        extractMetadata();
    }, [file]);


    useEffect(() => {
        if (animDurations.length > 0 && animDurations[RenderAnimation] !== undefined) {
            const durationInSeconds = animDurations[RenderAnimation];
            // Duration * FPS = Total Frames
            const calculatedMax = Math.floor(durationInSeconds * Fps);

            setMax(calculatedMax);
            setStart(0);
            setEnd(calculatedMax);
        }
    }, [RenderAnimation, Fps, animDurations]);

    


    const createRoom = () => {
        console.log("clicked REnder")

        if (!file) {
            alert("Please upload a GLB file first!");
            return;
        }

        const renderConfig = {
            roomId: roomId,
            file: file,
            fileHash: glbHash,
            previewUrl: previewUrl,
            animationIndex: RenderAnimation,
            startFrame: start,
            endFrame: end,
            fps: Fps,
            samples: samples,
            noiseThreshold: noiseThreshold,
            width: width,
            height: height
        };

        navigate(`/render`, { state: renderConfig })
    }


    return (
        <div className="h-6/8 text-white font-mono w-full flex flex-col">

            {/* HEADER: Flexbox for spacing between ends */}
            <header className="flex justify-between items-center mb-6">
                <div className="text-sm font-bold">&gt;_ upload</div>
                <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-sm text-gray-400">CLUSTER_READY</span>
                </div>
            </header>

            <div className='flex justify-between gap-10 w-full h-full'>
                <div className='flex flex-col justify-between h-full w-full'>
                    <div className='flex gap-4 h-4/7'>
                        <div className='border w-4/7'>
                            <div className='border-b p-2'>
                                Animations
                            </div>
                            <div className='overflow-scroll h-[87%] scrollbar-thin'>
                                {
                                    (Animations.length ? Animations.map((anim, index) => {
                                        return (
                                            <p className={`pl-4 my-2  text-[#606060] ${RenderAnimation === index ? 'text-black bg-white' : 'hover:text-white'}`} onClick={() => setRenderAnimation(index)}
                                            key={index}
                                            >
                                                {anim}
                                            </p>
                                        )
                                    })
                                        : (
                                            <p className="pl-4 my-2 text-gray-500">Upload Glb First</p>
                                        ))
                                }
                            </div>
                        </div>
                        <div className='flex flex-col justify-between'>

                            <div className='border h-3/7 flex gap-5 items-center flex-col'>
                                <div className='p-2 w-full'>
                                    samples
                                </div>
                                <input
                                    type="number"
                                    placeholder='1024'
                                    className="appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[80%]"
                                    value = {samples}
                                    onChange={(e)=> setSamples(e.target.value)}
                                />
                            </div>
                            <div className='border h-3/7 gap-5 flex items-center flex-col'>
                                <div className='p-2 w-full'>
                                    noise Threshold
                                </div>
                                <input
                                    type="number"
                                    placeholder='0.1'
                                    className="appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[80%]"
                                    value={noiseThreshold}
                                    onChange={(e)=>setNoiseThreshold(e.target.value)}
                                    />
                            </div>


                        </div>
                    </div>
                    <div className=''>
                        <p>render from range</p>
                        <div className="w-[80%] mb-4">

                            {/* Slider */}
                            <div className="relative h-6">

                                {/* Track */}
                                <div className="absolute top-1/2 left-0 w-full h-0.5 -translate-y-1/2 bg-white/20" />

                                {/* Selected range */}
                                <div
                                    className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-white"
                                    style={{
                                        left: `${(start / max) * 100}%`,
                                        right: `${100 - (end / max) * 100}%`,
                                    }}
                                />

                                {/* Start */}
                                <input
                                    type="range"
                                    min={min}
                                    max={max}
                                    value={start}
                                    onChange={(e) => {
                                        const value = Math.min(Number(e.target.value), end);
                                        setStart(value);
                                    }}
                                    className="range-input"
                                />

                                {/* End */}
                                <input
                                    type="range"
                                    min={min}
                                    max={max}
                                    value={end}
                                    onChange={(e) => {
                                        const value = Math.max(Number(e.target.value), start);
                                        setEnd(value);
                                    }}
                                    className="range-input"
                                />

                            </div>

                            <div className="flex justify-between text-sm text-white/60">
                                <span>{start}</span>
                                <span>{end}</span>
                            </div>

                        </div>

                        <div className="flex">
                            <div>
                                <div className='flex gap-4'>
                                    <p className='w-10'>start</p>
                                    <input className='appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[20%]'
                                        type="number"
                                        placeholder={start}
                                        onChange={(e) => {

                                            const value = Math.min(Number(e.target.value), end);
                                            setStart(value);
                                        }}
                                    />
                                </div>
                                <div className='flex gap-4'>
                                    <p className='w-10'>end</p>
                                    <input className="appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[20%]"
                                        type='number'
                                        placeholder={end}
                                        onChange={(e) => {
                                            const value = Math.max(Number(e.target.value), start);
                                            setEnd(value);
                                        }}
                                    />
                                </div>
                            </div>
                            <div>
                                <div className="flex gap-4">
                                    <p className='w-10'>Fps</p>
                                    <input className="appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[20%]"
                                        type='number'
                                        placeholder={30}
                                        value={Fps}
                                        onChange={(e) => (setFps(e.target.value))}
                                    />
                                </div>
                                <div>
                                    <div className="flex gap-4">
                                        <p>Width</p>
                                        <input className="appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[30%]"
                                            type='number'
                                            value={width}
                                            placeholder="1900"
                                            onChange={(e) => setWidth(e.target.value)}
                                        />
                                    </div >
                                    <div className="flex gap-4">
                                            <p>Height</p>
                                            <input className="appearance-none bg-transparent border-0 border-b border-white outline-none text-white text-center w-[30%]"
                                                type='number'
                                                placeholder="1400"
                                                value={height}
                                                onChange={(e) => setHeight(e.target.value)}
                                            />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                </div>
                <div className=' w-5/9'>
                        <div className='border aspect-square relative mb-3'>
                            <p className='border-b p-2 w-full'>asset model preview</p>
                            <div className='w-full h-[90%] flex items-center justify-center'>
                                <UploadBox file={file} setFile={setFile} loading={loading} setLoading={setLoading} previewUrl={previewUrl} setPreviewUrl={setPreviewUrl} />
                            </div>
                        </div>
                        <button className='border w-full aspect-6/1' onClick={createRoom}>start Rendering</button>
                    </div>
            </div >
        </div>
    )
}

export default UploadBefore
