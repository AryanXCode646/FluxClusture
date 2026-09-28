import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

describe('Browser WebGL Regression', { timeout: 300000 }, () => {
    let browser;
    let page;
    let viteServer;
    let port;

    before(async () => {
        viteServer = await createServer({
            root,
            server: { port: 0 } // Let Vite pick an open port
        });
        await viteServer.listen();
        port = viteServer.httpServer.address().port;

        // Use software WebGL for CI compatibility, if needed, or allow real GPU
        browser = await chromium.launch({
            args: ['--use-gl=angle', '--use-angle=swiftshader'] // Force software WebGL if needed for CI
        });
        page = await browser.newPage();
    });

    after(async () => {
        if (browser) await browser.close();
        if (viteServer) await viteServer.close();
    });

    test('renders a valid image and does not produce uniformly black or white output', async () => {
        await page.goto(`http://localhost:${port}/test/webglFixture.html`);
        
        const result = await page.evaluate(async () => {
            while (!window.__runRegressionTest) {
                await new Promise(r => setTimeout(r, 100));
            }
            return await window.__runRegressionTest({ width: 32, height: 32, samples: 3 });
        });

        assert.ok(result, 'Test returned a result');
        assert.equal(result.pixelCount, 32 * 32 * 4, 'Correct number of pixels read');
        assert.equal(result.allBlack, false, 'Output is uniformly black (rendering failed)');
        assert.equal(result.allWhite, false, 'Output is uniformly white (rendering failed)');
        assert.equal(result.isUniform, false, 'Output is completely uniform (rendering failed)');
        assert.ok(result.variance > 0, 'Image has zero variance');
        assert.ok(result.tracerSamples >= 3, 'Tracer reached target samples');
    });

    test('pure white environment does not get muted or altered', async () => {
        await page.goto(`http://localhost:${port}/test/webglFixture.html`);
        const result = await page.evaluate(async () => {
            while (!window.__runRegressionTest) {
                await new Promise(r => setTimeout(r, 100));
            }
            return await window.__runRegressionTest({ testMode: 'pure-white-env', width: 32, height: 32, samples: 3 });
        });

        assert.ok(result, 'Test returned a result');
        assert.equal(result.allBlack, false, 'Output is uniformly black');
        assert.equal(result.allWhite, false, 'Output is uniformly white');
        assert.equal(result.isUniform, false, 'Output is completely uniform');
    });
});
