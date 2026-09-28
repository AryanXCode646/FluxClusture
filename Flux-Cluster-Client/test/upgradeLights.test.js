import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Color, PointLight, Scene } from 'three';
import { ShapedAreaLight } from 'three-gpu-pathtracer';

import { upgradeSceneLights, worldBackgroundColor } from '../src/render/upgradeLights.js';

// three-gpu-pathtracer seeds its background gradient with a white top colour and
// only rebuilds it when the requested colour differs. Reproduce that seed here so
// the tests fail if the white-background workaround is ever removed.
const PATHTRACER_CACHED_WHITE = new Color().set(0xffffff);

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
    // Regression test for the solid black frames: a pure white background left
    // the tracer's environment texture empty, so it resolved to black.
    it('nudges a pure white background away from the path tracer cache seed', () => {
        const background = worldBackgroundColor(0xffffff);

        assert.notEqual(background.r, PATHTRACER_CACHED_WHITE.r, 'a white background would never rebuild the texture');
        assert.deepEqual(rgb(background), rgb(new Color().setHex(0xfefefe)));
    });

    it('stays visually white after the nudge', () => {
        const background = worldBackgroundColor(0xffffff);

        assert.ok(background.r > 0.99, 'the nudge must not be visible');
    });

    it('leaves non-white colours untouched', () => {
        assert.deepEqual(rgb(worldBackgroundColor(0x000000)), [0, 0, 0]);
        assert.deepEqual(rgb(worldBackgroundColor(0xff0000)), [1, 0, 0]);
        assert.deepEqual(rgb(worldBackgroundColor(0xfefefe)), [254 / 255, 254 / 255, 254 / 255]);
        assert.ok(worldBackgroundColor(0xfefefe).r !== 1);
    });

    it('converts hex components the same way the previous implementation did', () => {
        const background = worldBackgroundColor(0x3366ff);

        assert.equal(background.r, 0x33 / 255);
        assert.equal(background.g, 0x66 / 255);
        assert.equal(background.b, 1);
    });

    it('accepts a THREE.Color, including a white one', () => {
        assert.ok(worldBackgroundColor(new Color().set(0xffffff)).r < 1);
        assert.deepEqual(rgb(worldBackgroundColor(new Color().set(0xff0000))), [1, 0, 0]);
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
        assert.notDeepEqual(
            worldBackgroundColor(gi.color),
            PATHTRACER_CACHED_WHITE,
            'the default world GI must survive the background workaround'
        );
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
        // The library only lights surfaces its emitting normal faces, so the
        // placeholder rotation has to survive the swap.
        assert.equal(upgraded.rotation.x, 0.25);
        assert.equal(upgraded.rotation.y, 0.5);
        assert.equal(upgraded.rotation.z, 0.75);
        assert.equal(gi.color, 0xffffff);
    });
});
