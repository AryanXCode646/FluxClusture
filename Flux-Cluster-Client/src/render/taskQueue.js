/**
 * Deterministic FIFO task queue for serializing render tasks.
 *
 * Ensures only one renderChunk operation actively mutates shared WebGLRenderer,
 * WebGLPathTracer, and Camera state at any time. Prevents duplicate task execution,
 * guarantees deterministic FIFO execution order, and provides clean cancellation on unmount.
 */
export class RenderTaskQueue {
    constructor() {
        this._queue = [];
        this._activeItem = null;
        this._activeAbortController = null;
        this._pendingKeys = new Set();
        this._completedKeys = new Set();
        this._isPaused = false;
        this._isDisposed = false;
    }

    /**
     * Total number of tasks waiting in queue (excluding active task).
     */
    get queueLength() {
        return this._queue.length;
    }

    /**
     * Whether a task is currently executing.
     */
    get isBusy() {
        return this._activeItem !== null;
    }

    /**
     * Unique key identifying a task to prevent duplicate executions.
     * @param {object} task
     * @returns {string}
     */
    getTaskKey(task) {
        if (!task) return '';
        if (task.id !== undefined && task.id !== null) {
            return String(task.id);
        }
        return `${task.frame ?? 0}_${task.startX ?? 0}_${task.startY ?? 0}_${task.chunkWidth ?? 0}_${task.chunkHeight ?? 0}`;
    }

    /**
     * Pause processing new tasks in the queue (e.g., while scene is loading).
     */
    pause() {
        this._isPaused = true;
    }

    /**
     * Resume processing tasks in the queue.
     */
    resume() {
        this._isPaused = false;
        this._drain();
    }

    /**
     * Enqueue a task to be rendered.
     *
     * @param {object} task Task descriptor
     * @param {(task: object, signal: AbortSignal) => Promise<any>} executor Function that executes the render
     * @returns {Promise<any>} Resolves with executor result, or rejects on error/abort. If duplicate, returns existing or drops.
     */
    enqueue(task, executor) {
        if (this._isDisposed) {
            return Promise.reject(new Error('RenderTaskQueue is disposed'));
        }

        const key = this.getTaskKey(task);

        // Deduplication: prevent duplicate queueing or re-rendering of already running/pending/completed tasks
        if (this._pendingKeys.has(key)) {
            return Promise.resolve(null);
        }
        if (this._activeItem && this._activeItem.key === key) {
            return Promise.resolve(null);
        }
        if (this._completedKeys.has(key)) {
            return Promise.resolve(null);
        }

        this._pendingKeys.add(key);

        return new Promise((resolve, reject) => {
            this._queue.push({
                task,
                key,
                executor,
                resolve,
                reject
            });

            this._drain();
        });
    }

    /**
     * Abort the active render (if any), clear all pending tasks, and reject them with the given reason.
     *
     * @param {Error} [reason]
     */
    cancelAll(reason = new Error('Render queue cancelled')) {
        // Abort the currently executing task
        if (this._activeAbortController) {
            try {
                this._activeAbortController.abort();
            } catch {
                // Ignore errors from already settled controllers
            }
            this._activeAbortController = null;
        }

        // Reject and clear all queued tasks
        const pending = this._queue;
        this._queue = [];
        this._pendingKeys.clear();

        for (const item of pending) {
            item.reject(reason);
        }
    }

    /**
     * Cancel all tasks and mark queue disposed so no future tasks can be enqueued.
     */
    dispose() {
        this._isDisposed = true;
        this.cancelAll(new Error('RenderTaskQueue is disposed'));
        this._completedKeys.clear();
    }

    /**
     * Internal FIFO drain loop. Runs at most one task at a time.
     */
    async _drain() {
        if (this._isPaused || this._isDisposed || this._activeItem !== null || this._queue.length === 0) {
            return;
        }

        const item = this._queue.shift();
        this._pendingKeys.delete(item.key);
        this._activeItem = item;

        const abortController = new AbortController();
        this._activeAbortController = abortController;

        try {
            const result = await item.executor(item.task, abortController.signal);
            this._completedKeys.add(item.key);
            item.resolve(result);
        } catch (error) {
            item.reject(error);
        } finally {
            this._activeItem = null;
            this._activeAbortController = null;
            // Drain next task in FIFO order
            this._drain();
        }
    }
}
