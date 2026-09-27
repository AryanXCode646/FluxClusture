# Contributing to FluxCluster

First off, thank you for considering contributing to FluxCluster! It's people like you that make FluxCluster such a great tool for distributed WebGL path tracing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Project Architecture](#project-architecture)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Guidelines](#coding-guidelines)

## Code of Conduct

By participating in this project, you are expected to uphold a welcoming and inclusive environment. Please be respectful to all contributors and users.

## Project Architecture

FluxCluster is a distributed rendering engine built with modern web technologies:

1. **Flux-Cluster-Client (Frontend & Render Nodes)**
   - **Framework:** React + Vite
   - **3D Engine:** Three.js + `three-gpu-pathtracer`
   - **Networking:** Socket.io (Signaling) + WebRTC (Peer-to-Peer DataChannels)
   - **Role:** Can act as a "Master" (orchestrates the job, assigns tasks, encodes final video) or a "Worker" (receives GLB assets via WebRTC, renders assigned chunks, and sends pixels back).

2. **Flux-Cluster-server (Backend Orchestrator)**
   - **Framework:** Node.js (Express + Socket.io)
   - **State Management:** Redis (Task queues, room states, node tracking)
   - **Role:** Handles signaling for WebRTC, tracks active rooms, and coordinates chunk task assignments to available worker nodes.

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- Docker & Docker Compose (for running the Redis + Server stack)
- Git

### Local Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/FluxCluster.git
   cd FluxCluster
   ```

2. **Start the Backend Server:**
   ```bash
   cd Flux-Cluster-server
   docker compose up --build
   ```
   This will spin up a Redis instance and the Node.js Socket.io orchestrator.

3. **Start the Frontend Client:**
   In a new terminal window:
   ```bash
   cd Flux-Cluster-Client
   npm install
   npm run dev
   ```

## Development Workflow

### 1. Find an Issue
Look for open issues labeled `good first issue` or `help wanted`. If you want to work on a new feature, please open an issue first to discuss it with the maintainers.

### 2. Branching Strategy
- Always create a new branch from `main` for your work.
- Use descriptive branch names: `feature/add-new-lights`, `bugfix/fix-memory-leak`, or `docs/update-readme`.

### 3. Rendering Pipeline Adjustments
If you are modifying the rendering logic, most of the core logic lives in:
- `Flux-Cluster-Client/src/hooks/useRenderPipeline.js`: The central orchestrator for a single node's lifecycle.
- `Flux-Cluster-Client/src/render/gpuRenderer.js`: The WebGL PathTracer loop.
- `Flux-Cluster-Client/src/services/SwarmClient.js`: The Socket.io + WebRTC abstraction.

When modifying state inside React components that interact with the render pipeline, **be very careful with object references**. Because the renderer utilizes a `useEffect` hook, passing unstable references (like inline objects) will cause infinite re-render/re-connect loops. Always use `useMemo` or `useCallback` for configurations passed into `useRenderPipeline`.

## Pull Request Process

1. Ensure your code follows the existing style guidelines.
2. Update the README.md with details of changes to the interface or setup instructions, if applicable.
3. Test your changes locally by spinning up at least 1 Master and 1 Worker node in different browser tabs/windows.
4. Submit a Pull Request with a clear title and description. Include screenshots or videos if you are making UI or rendering output changes.

## Coding Guidelines

- **React:** We use functional components and hooks. Avoid class components.
- **Three.js:** Ensure that WebGL contexts and geometries/materials are properly disposed of when a component unmounts to prevent memory leaks (see `rendererRef.current.dispose()`).
- **Networking:** Keep WebRTC DataChannel payloads under 16KB to avoid max-message-size limits across different browsers.

Thank you for contributing! 🚀
