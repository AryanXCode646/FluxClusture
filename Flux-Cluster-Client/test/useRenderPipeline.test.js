import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const hookPath = fileURLToPath(new URL('../src/hooks/useRenderPipeline.js', import.meta.url));
const hookSource = readFileSync(hookPath, 'utf8');

// The hook's teardown runs inside useEffect and pulls in the socket client, so it
// cannot be invoked without a DOM and a live render tree. Mounting React here
// would need jsdom plus a renderer, which are not dependencies of this project, so
// the teardown is asserted as a source contract instead. Each assertion is scoped
// to the cleanup function so unrelated parts of the file cannot satisfy them.
function cleanupBody() {
    const start = hookSource.indexOf('return () => {');
    assert.notEqual(start, -1, 'the effect must return a cleanup function');

    let depth = 0;
    for (let i = start; i < hookSource.length; i++) {
        if (hookSource[i] === '{') depth++;
        if (hookSource[i] === '}') {
            depth--;
            if (depth === 0) return hookSource.slice(start, i + 1);
        }
    }
    assert.fail('the cleanup function is not closed');
}

const cleanup = cleanupBody();

describe('useRenderPipeline teardown', () => {
    it('stops in-flight renders before releasing any GPU resource', () => {
        const abortAt = cleanup.indexOf('abortController.abort()');
        assert.notEqual(abortAt, -1, 'cleanup must abort the render signal');
        assert.ok(abortAt < cleanup.indexOf('pathTracerRef.current'), 'abort must come before disposal');
    });

    it('disposes the path tracer, which owns render targets and materials', () => {
        assert.match(cleanup, /pathTracerRef\.current\.dispose\(\)/);
        assert.match(cleanup, /pathTracerRef\.current = null/);
    });

    it('disposes the path tracer while its WebGL context is still alive', () => {
        const tracerDisposeAt = cleanup.indexOf('pathTracerRef.current.dispose()');
        const contextLossAt = cleanup.indexOf('forceContextLoss()');
        assert.notEqual(tracerDisposeAt, -1);
        assert.ok(tracerDisposeAt < contextLossAt, 'disposing after forceContextLoss would leak the tracer resources');
    });

    it('only touches live resources so repeated cleanup stays safe', () => {
        assert.match(cleanup, /if \(pathTracerRef\.current\)/);
        assert.match(cleanup, /if \(rendererRef\.current\)/);
        assert.match(cleanup, /if \(swarmClient\.socketManager\.socket\)/);
    });

    it('marks the subscription inactive so late callbacks are dropped', () => {
        assert.match(hookSource, /isSubscribed = false/);
        // Every async continuation in the hook is guarded by this flag, in both
        // the bail-out and the "still mounted" direction.
        const guards = hookSource.match(/if \(!?isSubscribed\)/g) || [];
        assert.ok(guards.length >= 8, `only ${guards.length} isSubscribed guards found`);
    });
});
