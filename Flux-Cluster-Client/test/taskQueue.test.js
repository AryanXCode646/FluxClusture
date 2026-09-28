import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RenderTaskQueue } from '../src/render/taskQueue.js';

describe('RenderTaskQueue', () => {
    it('executes tasks in deterministic FIFO order one at a time', async () => {
        const queue = new RenderTaskQueue();
        const executionLog = [];

        let resolveA;
        const taskA = { id: 'task-A', frame: 0, startX: 0, startY: 0 };
        const promiseA = queue.enqueue(taskA, async () => {
            executionLog.push('start-A');
            await new Promise(r => { resolveA = r; });
            executionLog.push('end-A');
            return 'result-A';
        });

        const taskB = { id: 'task-B', frame: 0, startX: 64, startY: 0 };
        const promiseB = queue.enqueue(taskB, async () => {
            executionLog.push('start-B');
            executionLog.push('end-B');
            return 'result-B';
        });

        // Let macrotasks advance
        await new Promise(r => setTimeout(r, 10));

        // Task A has started, Task B has NOT started yet
        assert.deepEqual(executionLog, ['start-A']);
        assert.equal(queue.isBusy, true);
        assert.equal(queue.queueLength, 1);

        // Complete Task A
        resolveA();
        const [resA, resB] = await Promise.all([promiseA, promiseB]);

        assert.equal(resA, 'result-A');
        assert.equal(resB, 'result-B');
        assert.deepEqual(executionLog, ['start-A', 'end-A', 'start-B', 'end-B']);
        assert.equal(queue.isBusy, false);
        assert.equal(queue.queueLength, 0);
    });

    it('prevents duplicate task execution when task is queued or completed', async () => {
        const queue = new RenderTaskQueue();
        let runs = 0;

        let resolveActive;
        const task1 = { id: 'dup-1', frame: 1, startX: 0, startY: 0 };

        const promise1 = queue.enqueue(task1, async () => {
            runs += 1;
            await new Promise(r => { resolveActive = r; });
            return 'done-1';
        });

        // Duplicate enqueue while task1 is actively running
        const promiseDupActive = queue.enqueue(task1, async () => {
            runs += 1;
            return 'dup-active';
        });

        // Enqueue task2
        const task2 = { id: 'dup-2', frame: 1, startX: 64, startY: 0 };
        let runs2 = 0;
        const promise2 = queue.enqueue(task2, async () => {
            runs2 += 1;
            return 'done-2';
        });

        // Duplicate enqueue while task2 is queued
        const promiseDupQueued = queue.enqueue(task2, async () => {
            runs2 += 1;
            return 'dup-queued';
        });

        resolveActive();
        await Promise.all([promise1, promiseDupActive, promise2, promiseDupQueued]);

        assert.equal(runs, 1, 'task1 executed exactly once');
        assert.equal(runs2, 1, 'task2 executed exactly once');

        // Enqueue duplicate after completion
        const promiseDupCompleted = queue.enqueue(task1, async () => {
            runs += 1;
            return 'dup-completed';
        });
        await promiseDupCompleted;
        assert.equal(runs, 1, 'task1 was not re-executed after completion');
    });

    it('pauses and resumes queue processing', async () => {
        const queue = new RenderTaskQueue();
        queue.pause();

        let executed = false;
        const task = { id: 'paused-task' };
        queue.enqueue(task, async () => {
            executed = true;
            return 'done';
        });

        await new Promise(r => setTimeout(r, 20));
        assert.equal(executed, false, 'task must not run while paused');
        assert.equal(queue.queueLength, 1);

        queue.resume();
        await new Promise(r => setTimeout(r, 20));
        assert.equal(executed, true, 'task must run after resuming');
    });

    it('cancels active task and clears queued tasks on cancelAll', async () => {
        const queue = new RenderTaskQueue();
        let abortedSignal = null;

        const task1 = { id: 't1' };
        const promise1 = queue.enqueue(task1, async (_task, signal) => {
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    abortedSignal = true;
                    reject(new Error('Render aborted'));
                });
            });
        });

        const task2 = { id: 't2' };
        let task2Ran = false;
        const promise2 = queue.enqueue(task2, async () => {
            task2Ran = true;
        });

        // Let task1 start
        await new Promise(r => setTimeout(r, 10));
        assert.equal(queue.isBusy, true);
        assert.equal(queue.queueLength, 1);

        queue.cancelAll(new Error('Cancelled by test'));

        await assert.rejects(promise1, /Render aborted/);
        await assert.rejects(promise2, /Cancelled by test/);

        assert.equal(abortedSignal, true, 'active task received abort signal');
        assert.equal(task2Ran, false, 'queued task2 was cancelled without running');
        assert.equal(queue.queueLength, 0);
        assert.equal(queue.isBusy, false);
    });

    it('continues processing subsequent tasks when one task fails', async () => {
        const queue = new RenderTaskQueue();
        const task1 = { id: 'fail-1' };
        const promise1 = queue.enqueue(task1, async () => {
            throw new Error('Task 1 failed');
        });

        const task2 = { id: 'ok-2' };
        let task2Ran = false;
        const promise2 = queue.enqueue(task2, async () => {
            task2Ran = true;
            return 'success-2';
        });

        await assert.rejects(promise1, /Task 1 failed/);
        const result2 = await promise2;

        assert.equal(task2Ran, true);
        assert.equal(result2, 'success-2');
    });

    it('rejects new tasks after disposal', async () => {
        const queue = new RenderTaskQueue();
        queue.dispose();

        await assert.rejects(
            queue.enqueue({ id: 'after-dispose' }, async () => {}),
            /RenderTaskQueue is disposed/
        );
    });
});
