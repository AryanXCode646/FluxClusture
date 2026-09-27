import { SocketManager } from './SocketManager';
import { WebRTCManager } from './WebRTCManager';

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

class SwarmClient {
    constructor() {
        // Instantiate the two separate brains (Composition)
        this.socketManager = new SocketManager(SOCKET_URL);

        // Pass a callback so WebRTC can ask the socket to send signals
        this.webrtcManager = new WebRTCManager(
            (signalPayload) => {
                this.socketManager.emit('WEBRTC_SIGNAL', signalPayload);
            },
            (fileUrl) => {
                this._trigger('status', 'GLB file downloaded successfully!');

                // Hydrate the local buffer so components can use it immediately
                fetch(fileUrl)
                    .then(res => res.arrayBuffer())
                    .then(buffer => {
                        this.glbBuffer = buffer;
                        this._trigger('fileReady', fileUrl);
                    })
                    .catch(err => console.error("Failed to hydrate GLB buffer from Blob URL", err));
            },
            // NEW: Handle incoming render chunks
            (metadata, pixelBuffer) => {
                this._trigger('tileReceived', { metadata, pixelBuffer });
            }
        );

        this.role = null;
        this.listeners = {}; // Callbacks for React

        this.glbBuffer = null;

        this.width = 1900;
        this.height = 1400;
        this.noise = 0.1;
        this.samples = 1024;
        this.animationIndex = 0;
        this.fps = 30;
        this.glbHash = null;
        this.ownerId = null;
    }

    // --- React API ---

    // React calls this to listen for updates
    on(event, callback) {
        this.listeners[event] = callback;
    }

    // Triggers the React callbacks safely
    _trigger(event, data) {
        if (this.listeners[event]) this.listeners[event](data);
    }
    setRenderSetting(ownerId, glbHash, width, height, noise, samples, animationIndex, fps) {
        this.ownerId = ownerId;
        this.glbHash = glbHash;
        this.width = width;
        this.height = height;
        this.noise = noise;
        this.samples = samples;
        this.animationIndex = animationIndex;
        this.fps = fps;
    }


    async loadSeederFile(fileUrl) {
        try {
            this._trigger('status', 'Loading GLB file into memory...');
            const response = await fetch(fileUrl);
            this.glbBuffer = await response.arrayBuffer();
            this._trigger('status', 'File ready for seeding.');
        } catch (error) {
            console.error("Failed to load GLB buffer:", error);
        }
    }

    joinAsWorker(roomId) {
        this.role = 'worker';
        this.socketManager.connect();

        const onConnected = () => {
            console.log("[SwarmClient] Socket connected. Proceeding with worker join sequence.");
            this._trigger('status', 'Connected. Requesting file...');

            this.socketManager.emit('JOIN_ROOM', { roomId });
            this.socketManager.emit('REQUEST_SEEDER', { roomId });

            console.log("[SwarmClient] Emitting GET_OWNER_ID...");
            this.socketManager.socket.emit('GET_OWNER_ID', roomId, (response) => {
                console.log("[SwarmClient] GET_OWNER_ID response:", response);
                if (response && response.ownerId) {
                    console.log(`[SwarmClient] Received Master ID: ${response.ownerId}. Setting up render stream...`);
                    try {
                        this.webrtcManager.setupPersistentRenderChannel(response.ownerId, this.socketManager.socket.id);
                        console.log("[SwarmClient] setupPersistentRenderChannel completed successfully.");
                    } catch (err) {
                        console.error("[SwarmClient] Error in setupPersistentRenderChannel:", err);
                    }
                } else {
                    console.error("[SwarmClient] Failed to retrieve Master ID! Render stream will not open. Response was:", response);
                }
            });

            this.socketManager.socket.emit('GET_RENDER_SETTINGS', roomId, (response) => {
                console.log("[SwarmClient] GET_RENDER_SETTINGS response:", response);
                if (response && response.success) {
                    const { ownerId, glbHash, height, width, samples, noiseThreshold, animationIndex, fps } = response.settings;
                    this.setRenderSetting(ownerId, glbHash, height, width, samples, noiseThreshold, animationIndex, fps);
                }
                else {
                    console.error("[SwarmClient] Failed to fetch settings:", response?.error);
                }
            })
        };

        if (this.socketManager.socket && this.socketManager.socket.connected) {
            onConnected();
        } else {
            this.socketManager.removeAllListeners('connect');
            this.socketManager.on('connect', onConnected);
        }

        // Wire up the signaling bridge: Socket -> WebRTC
        this.socketManager.removeAllListeners('WEBRTC_SIGNAL');
        this.socketManager.on('WEBRTC_SIGNAL', (payload) => {
            this.webrtcManager.handleIncomingSignal(payload.sender, payload);
        });

        this.socketManager.removeAllListeners('ASSIGN_TASK');
        this.socketManager.on('ASSIGN_TASK', (task) => {
            this._trigger('newTask', task);
        });

        this.socketManager.removeAllListeners('WAIT');
        this.socketManager.on('WAIT', () => {
            this._trigger('status', 'Idle. Waiting for tasks...');
        });

        this.socketManager.removeAllListeners('TASKS_AVAILABLE');
        this.socketManager.on('TASKS_AVAILABLE', () => {
            if (this.role === 'worker') {
                this.socketManager.emit('REQUEST_TASK');
            }
        });

        this.socketManager.removeAllListeners('INITIATE_OFFER');
        this.socketManager.on("INITIATE_OFFER", async (payload) => {
            // We pass the requester ID to the WebRTC Manager, which handles the rest

            if (!this.glbBuffer) {
                console.error("[SwarmClient] Cannot initiate offer: GLB buffer is empty.");
                return;
            }

            await this.webrtcManager.initiateOffer(payload.requester, this.glbBuffer);
        });
    }

    joinAsMaster(roomId) {
        this.role = 'master';
        console.log("joining the room as master");
        this.socketManager.connect();
        console.log("connected to server")
        this.socketManager.removeAllListeners('connect');
        this.socketManager.on('connect', () => {
            this._trigger('status', 'Master node connected. Ready to start job.');
            this.socketManager.emit('JOIN_ROOM', { roomId });
        });

        this.socketManager.removeAllListeners('WEBRTC_SIGNAL');
        this.socketManager.on('WEBRTC_SIGNAL', (payload) => {
            this.webrtcManager.handleIncomingSignal(payload.sender, payload);
        });

        // Add listener so Master can act as a WebRTC seeder
        this.socketManager.removeAllListeners('INITIATE_OFFER');
        this.socketManager.on("INITIATE_OFFER", async (payload) => {
            if (!this.glbBuffer) {
                console.error("[SwarmClient Master] Cannot initiate offer: GLB buffer is empty.");
                return;
            }
            await this.webrtcManager.initiateOffer(payload.requester, this.glbBuffer);
        });

        // --- NEW: Enable Master to receive tasks ---
        this.socketManager.removeAllListeners('ASSIGN_TASK');
        this.socketManager.on('ASSIGN_TASK', (task) => {
            this._trigger('newTask', task);
        });

        this.socketManager.removeAllListeners('WAIT');
        this.socketManager.on('WAIT', () => {
            this._trigger('status', 'Master rendering idle. Waiting for tasks...');
        });

        this.socketManager.removeAllListeners('TASKS_AVAILABLE');
        this.socketManager.on('TASKS_AVAILABLE', () => {
            // Master can now request tasks too!
            if (this.role === 'master' || this.role === 'worker') {
                this.socketManager.emit('REQUEST_TASK');
            }
        });

        this.socketManager.removeAllListeners('frameComplete');
        this.socketManager.on('frameComplete', (task) => {
            this._trigger('frameComplete', task);
        })
    }

    startRenderJob(roomId, startFrame, endFrame, width, height, fps, glbHash, samples, noiseThreshold, animationIndex) {
        if (!this.socketManager.socket) return;

        this.socketManager.emit('INIT_JOB', {
            roomId,
            startFrame,
            endFrame,
            width,
            height,
            fps,
            glbHash,
            samples,
            noiseThreshold,
            animationIndex,
            ownerId: this.socketManager.id
        });
    }

    submitRenderedTile(task, imageData) {
        // Route the pixels
        console.log("sending render chunks metaData and image")
        if (this.role === 'worker') {
            // Workers send pixels over WebRTC
            if (this.webrtcManager.renderChannel && this.webrtcManager.renderChannel.readyState === 'open') {
                const metadata = JSON.stringify({
                    taskId: task.id, frame: task.frame,
                    startX: task.startX, startY: task.startY,
                    width: task.totalWidth, height: task.totalHeight,
                    chunkWidth: task.chunkWidth, chunkHeight: task.chunkHeight
                });
                this.webrtcManager.renderChannel.send(metadata);

                // Send the pixel buffer in safe 16KB chunks to avoid WebRTC max message size limits (64KB)
                const buffer = imageData.buffer;
                const CHUNK_SIZE = 16384;
                let offset = 0;
                
                while (offset < buffer.byteLength) {
                    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
                    this.webrtcManager.renderChannel.send(chunk);
                    offset += chunk.byteLength;
                }
            } else {
                console.warn(`[SwarmClient] Render channel not open. ReadyState: ${this.webrtcManager.renderChannel?.readyState}`);
            }
        }
        else if (this.role === 'master') {
            // NEW: Master bypasses WebRTC and triggers the local draw event immediately
            const metadata = {
                taskId: task.id, frame: task.frame,
                startX: task.startX, startY: task.startY,
                width: task.totalWidth, height: task.totalHeight,
                chunkWidth: task.chunkWidth, chunkHeight: task.chunkHeight
            };
            this._trigger('tileReceived', { metadata, pixelBuffer: imageData.buffer });
        }

        // Greedy Node: instantly ask for next task
        this.socketManager.emit('REQUEST_TASK');
    }
}

// Export a single instance so the whole app shares the exact same state
export const swarmClient = new SwarmClient();