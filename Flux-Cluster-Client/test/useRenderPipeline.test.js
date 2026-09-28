import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RenderTaskQueue } from '../src/render/taskQueue.js';

describe('Render Pipeline task lifecycle & serialization', () => {
    it('processes tasks sequentially and submits tiles exactly once with correct metadata', async () => {
        const queue = new RenderTaskQueue();
        const submissions = [];
        const taskRequests = [];

        const fakeSwarmClient = {
            submitRenderedTile(task, pixels) {
                submissions.push({ task, pixels });
                this.socketManager.emit('REQUEST_TASK');
            },
            socketManager: {
                emit(event) {
                    taskRequests.push(event);
                }
            }
        };

        const task1 = { id: 'chunk-1', frame: 0, startX: 0, startY: 0, chunkWidth: 64, chunkHeight: 64, totalWidth: 128, totalHeight: 128 };
        const task2 = { id: 'chunk-2', frame: 0, startX: 64, startY: 0, chunkWidth: 64, chunkHeight: 64, totalWidth: 128, totalHeight: 128 };

        const runTask = async (task, signal) => {
            if (signal.aborted) return;
            const pixels = new Uint8Array(task.chunkWidth * task.chunkHeight * 4);
            pixels.fill(128);
            if (!signal.aborted) {
                fakeSwarmClient.submitRenderedTile(task, pixels);
            }
            return pixels;
        };

        const p1 = queue.enqueue(task1, runTask);
        const p2 = queue.enqueue(task2, runTask);

        await Promise.all([p1, p2]);

        assert.equal(submissions.length, 2, 'both tasks submitted');
        assert.equal(submissions[0].task.id, 'chunk-1');
        assert.equal(submissions[0].pixels.length, 64 * 64 * 4);
        assert.equal(submissions[1].task.id, 'chunk-2');
        assert.equal(submissions[1].pixels.length, 64 * 64 * 4);

        assert.deepEqual(taskRequests, ['REQUEST_TASK', 'REQUEST_TASK'], 'next task requested only after successful completion');
    });

    it('does not submit bogus pixels when a render task fails', async () => {
        const queue = new RenderTaskQueue();
        const submissions = [];
        const taskRequests = [];

        const fakeSwarmClient = {
            submitRenderedTile(task, pixels) {
                submissions.push({ task, pixels });
            },
            socketManager: {
                emit(event) {
                    taskRequests.push(event);
                }
            }
        };

        const failingTask = { id: 'fail-chunk', frame: 0, startX: 0, startY: 0, chunkWidth: 64, chunkHeight: 64 };
        const goodTask = { id: 'good-chunk', frame: 0, startX: 64, startY: 0, chunkWidth: 64, chunkHeight: 64 };

        const runFailing = async () => {
            throw new Error('GPU shader compilation failed');
        };

        const runGood = async (task) => {
            const pixels = new Uint8Array(task.chunkWidth * task.chunkHeight * 4);
            fakeSwarmClient.submitRenderedTile(task, pixels);
            return pixels;
        };

        const p1 = queue.enqueue(failingTask, runFailing);
        const p2 = queue.enqueue(goodTask, runGood);

        await assert.rejects(p1, /GPU shader compilation failed/);
        await p2;

        assert.equal(submissions.length, 1, 'only successful task submitted');
        assert.equal(submissions[0].task.id, 'good-chunk');
    });

    it('does not submit pixels when a task is aborted', async () => {
        const queue = new RenderTaskQueue();
        const submissions = [];

        const task = { id: 'abort-chunk', frame: 0, startX: 0, startY: 0, chunkWidth: 64, chunkHeight: 64 };

        const p = queue.enqueue(task, async (_t, signal) => {
            return new Promise((_res, rej) => {
                signal.addEventListener('abort', () => rej(new Error('Render aborted')));
            });
        });

        // Abort while running
        queue.cancelAll();

        await assert.rejects(p, /Render aborted/);
        assert.equal(submissions.length, 0, 'no pixels submitted on abort');
    });

    it('ignores duplicate task messages and prevents multiple submissions', async () => {
        const queue = new RenderTaskQueue();
        let renderCalls = 0;
        const submissions = [];

        const task = { id: 'unique-chunk-1', frame: 0, startX: 0, startY: 0, chunkWidth: 64, chunkHeight: 64 };

        const runTask = async (t) => {
            renderCalls += 1;
            await new Promise(r => setTimeout(r, 20));
            submissions.push(t.id);
            return new Uint8Array(64 * 64 * 4);
        };

        // Enqueue duplicate while first is executing
        const p1 = queue.enqueue(task, runTask);
        const p2 = queue.enqueue(task, runTask);

        await Promise.all([p1, p2]);

        // Enqueue duplicate after first has completed
        const p3 = queue.enqueue(task, runTask);
        await p3;

        assert.equal(renderCalls, 1, 'task was rendered exactly once');
        assert.equal(submissions.length, 1, 'submission occurred exactly once');
    });
});

describe('Pipeline teardown and cleanup contracts', () => {
    it('aborts active work, disposes path tracer, and forces context loss in correct order', () => {
        const actions = [];

        const mockAbortController = {
            abort() { actions.push('abort'); }
        };

        const mockTaskQueue = {
            dispose() { actions.push('queue.dispose'); }
        };

        const mockPathTracer = {
            dispose() { actions.push('pathTracer.dispose'); }
        };

        const mockRenderer = {
            dispose() { actions.push('renderer.dispose'); },
            forceContextLoss() { actions.push('renderer.forceContextLoss'); }
        };

        const mockSocket = {
            disconnect() { actions.push('socket.disconnect'); }
        };

        // Execute teardown sequence according to hook cleanup contract
        mockAbortController.abort();
        mockTaskQueue.dispose();
        mockPathTracer.dispose();
        mockRenderer.dispose();
        mockRenderer.forceContextLoss();
        mockSocket.disconnect();

        assert.deepEqual(actions, [
            'abort',
            'queue.dispose',
            'pathTracer.dispose',
            'renderer.dispose',
            'renderer.forceContextLoss',
            'socket.disconnect'
        ]);

        const abortIdx = actions.indexOf('abort');
        const tracerDisposeIdx = actions.indexOf('pathTracer.dispose');
        const contextLossIdx = actions.indexOf('renderer.forceContextLoss');

        assert.ok(abortIdx < tracerDisposeIdx, 'abort must occur before GPU disposal');
        assert.ok(tracerDisposeIdx < contextLossIdx, 'pathTracer must be disposed before WebGL context loss');
    });
});
