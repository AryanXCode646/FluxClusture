# FluxCluster: A P2P Browser-Based Distributed Compute Grid

FluxCluster is a fault-tolerant, hybrid distributed computing architecture that pools the idle GPU and CPU resources of standard browser tabs into a unified high-performance computing (HPC) cluster. Designed to bypass the limitations of single-device rendering and central server bandwidth bottlenecks, it offloads heavy data distribution to a peer-to-peer swarm while maintaining precise task orchestration via a lightweight centralized control plane.

## Architecture Overview

The system divides network responsibilities between a signaling/control plane and a heavy data plane, utilizing three distinct node types:

1. **The Master Node (Orchestrator)**: A lightweight Node.js server running WebSockets. It acts as the cluster's traffic cop. It never processes or transmits heavy 3D assets or pixel buffers. Its sole responsibility is assigning tasks, tracking worker health, and maintaining the global state queue via a Redis cache.
2. **The Viewer Node (The Client)**: The browser tab that initiates the workload. It handles the initial parsing of the 3D scene, seeds the P2P swarm, and acts as the final destination for all rendered pixel chunks. It stitches the final image together and applies post-processing.
3. **The Worker Nodes (The Swarm)**: Browser tabs connected by external users. They pull 3D assets directly from other peers via WebRTC, receive mathematical rendering tasks from the Master via WebSocket, execute path tracing in the background, and stream the resulting pixel data back to the Viewer.

## Technology Stack

- **Control Plane (Signaling & Tasks)**: Node.js, `ws` (WebSockets), Redis (State & Queue Management).
- **Data Plane (Asset Swarming)**: WebRTC DataChannels (SCTP protocol for reliable chunked delivery), WebTorrent/Simple-Peer for peer discovery and mesh sharing.
- **Rendering Engine**: `three-gpu-pathtracer` (WebGL 2 / WebGPU compute) for physically based rendering (Principled BSDF, Multiple Importance Sampling) running inside Web Workers via OffscreenCanvas.
- **Post-Processing**: `oidn-wasm` (OpenImageDenoise WebAssembly port) for AI-driven noise reduction on the Viewer node.

## The Distributed Pipeline

### 1. Asset Preparation & Spatial Indexing
- The Viewer loads a standard `.glb` (glTF 2.0) 3D scene.
- The Viewer’s CPU utilizes `three-mesh-bvh` to calculate a Bounding Volume Hierarchy (BVH) and flattens the tree into a highly optimized 1D binary buffer.
- The vertex buffers, material definitions, and BVH array are packaged into a single binary payload.

### 2. P2P Swarm Initialization
- The Viewer seeds this binary payload over WebRTC and registers its availability with the Master.
- When a new Worker joins, it requests the asset manifest from the Master, receives the WebRTC signaling data for active peers, and downloads the scene geometry directly from the swarm, bypassing the Node.js server entirely.

### 3. Task Orchestration
- The Viewer defines the grid (e.g., dividing a 1080p frame into 64x64 pixel tiles) and pushes the task queue to the Master’s Redis instance.
- Once a Worker finishes downloading the P2P assets, it sends a `READY` heartbeat over its WebSocket connection.
- The Master pops a tile task from Redis (e.g., `tile_04_12`, 128 samples, specific camera matrix) and assigns it to the Worker.

### 4. Worker Execution
- The Worker uploads the BVH and geometry buffers to its local GPU.
- An offscreen `three-gpu-pathtracer` instance executes the rendering pass, utilizing the local GPU’s standard compute ALUs (CUDA cores) to trace the rays, traverse the BVH, and calculate light bounces.
- The result is read back from the GPU as a `Float32Array` (HDR pixel data).

### 5. Delivery & Accumulation
- The Worker slices the massive floating-point array into 16KB WebRTC-safe chunks.
- The chunks are streamed sequentially over a reliable SCTP WebRTC DataChannel directly to the Viewer Node.
- The Viewer reassembles the array, blits it onto an HTML5 Canvas, and emits an `ACK_TILE` signal to the Master to permanently clear the task from the Redis queue.

## Fault Tolerance & Straggler Mitigation

- **Stateless Orchestration**: Because the Master stores the entire render queue and active worker list in Redis, the Node.js server can crash and restart without losing a single pixel of progress.
- **Dynamic Time-To-Live (TTL)**: The Master continuously calculates a moving average of tile completion times. If a Worker’s browser is throttled by the OS and exceeds the dynamic TTL (average time multiplied by 3), the Master flags the Worker as "throttled" and pushes the tile back onto the Redis queue for another node.
- **Duplicate Dropping**: If a throttled Worker eventually finishes and transmits its late data to the Viewer, the Viewer checks a local Set of completed chunk IDs and silently drops the duplicate to prevent race conditions.
- **Cascade Kill**: If the Viewer Node disconnects from the Master, the Master immediately wipes the associated queue from Redis and broadcasts an `ABORT` signal to all Workers, instantly freeing up the cluster for the next user.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines on how to get started, project architecture references, and development workflow.
