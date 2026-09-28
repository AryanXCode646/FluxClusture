import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Color, PointLight, Scene } from 'three';
import { ShapedAreaLight, GradientEquirectTexture } from 'three-gpu-pathtracer';

import { upgradeSceneLights, worldBackgroundColor, ensurePathTracerEnvironment } from '../src/render/upgradeLights.js';

function rgb(color) {
    return [color.r, color.g, color.b];
}

function sceneWithLight(name, { color = 0xffffff, intensity = 1 } = {}) {
    const scene = new Scene();
    const light = new PointLight(color, intensity);
    light.name = name;
    scene.add(light);
    return { scene, light };
}

describe('worldBackgroundColor', () => {
    it('preserves exact pure white without any workaround mutation', () => {
        const background = worldBackgroundColor(0xffffff);

        assert.equal(background.r, 1);
        assert.equal(background.g, 1);
        assert.equal(background.b, 1);
        assert.equal(background.getHex(), 0xffffff);
    });

    it('preserves exact pure black', () => {
        const background = worldBackgroundColor(0x000000);

        assert.deepEqual(rgb(background), [0, 0, 0]);
        assert.equal(background.getHex(), 0x000000);
    });

    it('leaves arbitrary colors untouched', () => {
        assert.deepEqual(rgb(worldBackgroundColor(0xff0000)), [1, 0, 0]);
        const mid = worldBackgroundColor(0x3366ff);
        assert.equal(mid.r, 0x33 / 255);
        assert.equal(mid.g, 0x66 / 255);
        assert.equal(mid.b, 1);
    });

    it('accepts a THREE.Color without mutation', () => {
        const inputWhite = new Color(0xffffff);
        const resultWhite = worldBackgroundColor(inputWhite);
        assert.equal(resultWhite.r, 1);
        assert.equal(resultWhite.getHex(), 0xffffff);

        const inputRed = new Color(0xff0000);
        assert.deepEqual(rgb(worldBackgroundColor(inputRed)), [1, 0, 0]);
    });

    it('falls back to black when no colour is given', () => {
        assert.deepEqual(rgb(worldBackgroundColor(undefined)), [0, 0, 0]);
        assert.deepEqual(rgb(worldBackgroundColor(null)), [0, 0, 0]);
    });
});

describe('upgradeSceneLights', () => {
    it('defaults to a white environment when the GLB has no World_GI', () => {
        const { scene } = sceneWithLight('SomethingElse');

        const gi = upgradeSceneLights(scene);

        assert.equal(gi.color, 0xffffff);
        assert.equal(gi.intensity, 1.0);
        assert.deepEqual(rgb(worldBackgroundColor(gi.color)), [1, 1, 1]);
    });

    it('reads the environment from a World_GI placeholder', () => {
        const { scene, light } = sceneWithLight('World_GI', { color: 0x223344, intensity: 2.5 });

        const gi = upgradeSceneLights(scene);

        assert.equal(gi.color, 0x223344);
        assert.equal(gi.intensity, 2.5);
        assert.equal(scene.children.includes(light), false, 'the placeholder must not stay in the scene');
    });

    it('upgrades an area placeholder and keeps its transform', () => {
        const { scene, light } = sceneWithLight('Area');
        light.position.set(1, 2, 3);
        light.rotation.set(0.25, 0.5, 0.75);
        light.scale.set(2, 4, 1);

        const gi = upgradeSceneLights(scene);

        assert.equal(scene.children.includes(light), false);
        const upgraded = scene.children[0];
        assert.ok(upgraded instanceof ShapedAreaLight, `expected a ShapedAreaLight, got ${upgraded.type}`);
        assert.equal(upgraded.width, 2);
        assert.equal(upgraded.height, 4);
        assert.equal(upgraded.rotation.x, 0.25);
        assert.equal(upgraded.rotation.y, 0.5);
        assert.equal(upgraded.rotation.z, 0.75);
        assert.equal(gi.color, 0xffffff);
    });
});

describe('ensurePathTracerEnvironment', () => {
    function createMockPathTracer(initialBgColor) {
        const scene = new Scene();
        if (initialBgColor !== undefined) {
            scene.background = new Color(initialBgColor);
        }
        return {
            scene,
            _pathTracer: { material: {} },
            _colorBackground: null,
            updateEnvironment() {
                const s = this.scene;
                const mat = this._pathTracer.material;
                if (s && s.background && s.background.isColor) {
                    this._colorBackground = this._colorBackground || new GradientEquirectTexture(16);
                    const colorBg = this._colorBackground;
                    if (!colorBg.topColor.equals(s.background)) {
                        colorBg.topColor.set(s.background);
                        colorBg.bottomColor.set(s.background);
                        colorBg.update();
                    }
                    mat.backgroundMap = colorBg;
                }
            }
        };
    }

    it('populates texture data for pure white without mutating scene color', () => {
        const tracer = createMockPathTracer(0xffffff);

        // Standard three-gpu-pathtracer leaves data all 0 for pure white because
        // constructor topColor is 0xffffff, skipping update()
        tracer.updateEnvironment();
        assert.equal(tracer._colorBackground.image.data[0], 0, 'reproduces the uninitialized buffer issue');

        // ensurePathTracerEnvironment fixes the texture data while preserving pure white scene color
        ensurePathTracerEnvironment(tracer);
        assert.equal(tracer.scene.background.getHex(), 0xffffff, 'scene background color is preserved');
        assert.equal(tracer._colorBackground.image.data[0], 1, 'texture data is populated with white');
    });

    it('populates texture data for pure black', () => {
        const tracer = createMockPathTracer(0x000000);
        ensurePathTracerEnvironment(tracer);
        assert.equal(tracer.scene.background.getHex(), 0x000000);
        assert.equal(tracer._colorBackground.image.data[0], 0);
    });

    it('populates texture data for nontrivial colors', () => {
        const tracer = createMockPathTracer(0xff0000);
        ensurePathTracerEnvironment(tracer);
        assert.equal(tracer.scene.background.getHex(), 0xff0000);
        assert.equal(tracer._colorBackground.image.data[0], 1);
        assert.equal(tracer._colorBackground.image.data[1], 0);
        assert.equal(tracer._colorBackground.image.data[2], 0);
    });

    it('handles repeated environment color changes correctly', () => {
        const tracer = createMockPathTracer(0xffffff);
        ensurePathTracerEnvironment(tracer);
        assert.equal(tracer._colorBackground.image.data[0], 1);

        // Change to black
        tracer.scene.background.setHex(0x000000);
        ensurePathTracerEnvironment(tracer);
        assert.equal(tracer._colorBackground.image.data[0], 0);

        // Change back to white
        tracer.scene.background.setHex(0xffffff);
        ensurePathTracerEnvironment(tracer);
        assert.equal(tracer._colorBackground.image.data[0], 1);
    });
});
