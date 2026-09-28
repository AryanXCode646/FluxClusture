import { 
    Color,
    DirectionalLight 
} from 'three';
import { 
    ShapedAreaLight, 
    PhysicalSpotLight 
} from 'three-gpu-pathtracer';

/**
 * Traverses the GLB scene, finds placeholder Point lights by name, 
 * and upgrades them to their intended physical light types.
 * Returns the extracted World GI settings.
 */
export function upgradeSceneLights(scene) {
    const lightsToAdd = [];
    const nodesToRemove = [];
    
    // Default fallback if no World_GI placeholder is found
    let globalIllumination = { intensity: 1.0, color: 0xffffff };
    

    scene.traverse((child) => {
        
        // Only target Point lights acting as our data carriers
        if (child.isPointLight && child.name) {
            const name = child.name.toLowerCase();
            let newLight = null;

            // Extract the core data preserved by the GLB exporter
            const { position, rotation, color, intensity, distance, decay } = child;
            
            // The constructors expect a hex value, but color is a THREE.Color with normalized r,g,b.
            const hexColor = color && color.isColor ? color.getHex() : color;

            if (name.includes('area')) {
                // Area lights use the placeholder's scale for physical dimensions
                const width = child.scale.x;
                const height = child.scale.y;
                newLight = new ShapedAreaLight(hexColor, intensity, width, height);
                newLight.isCircular = false;
                newLight.position.copy(position);
                newLight.rotation.copy(rotation);
            } 
            else if (name.includes('spot')) {
                // Spot lights: Math.PI/4 (45 degrees) is a safe default angle
                newLight = new PhysicalSpotLight(hexColor, intensity, distance, Math.PI / 4, 0.5, decay);
                newLight.radius = 0.05; // Set a small physical radius for soft shadows
                newLight.position.copy(position);
                newLight.rotation.copy(rotation);
            } 
            else if (name.includes('sun')) {
                // Sun translates to DirectionalLight (infinite parallel rays)
                newLight = new DirectionalLight(hexColor, intensity);
                newLight.position.copy(position);
                newLight.rotation.copy(rotation);
            }
            else if (name.includes('world_gi')) {
                // Hijack this specific light to act as the environment controller
                globalIllumination = { intensity, color: hexColor };
                nodesToRemove.push(child);
                return; // Skip adding a physical light for this placeholder
            }
            // If it's just named 'point' or something else, we leave it as a native PointLight

            // If we generated a replacement, queue it up
            if (newLight) {
                lightsToAdd.push(newLight);
                nodesToRemove.push(child);
            }
        }
    });

    // Execute the swap
    nodesToRemove.forEach(node => node.removeFromParent());
    lightsToAdd.forEach(light => scene.add(light));

    return globalIllumination;
}

/**
 * Builds the solid background colour for a world GI value without mutating requested colors.
 *
 * @param {number|import('three').Color} color Hex colour or THREE.Color.
 * @returns {import('three').Color} Background colour for the scene.
 */
export function worldBackgroundColor(color) {
    const background = new Color(0x000000);

    if (color && color.isColor) {
        background.copy(color);
    } else if (color !== undefined && color !== null) {
        background.setRGB(
            ((color >> 16) & 255) / 255,
            ((color >> 8) & 255) / 255,
            (color & 255) / 255
        );
    }

    return background;
}

/**
 * Ensures the path tracer's internal background equirect texture is properly
 * generated and synchronized with scene.background.
 *
 * In three-gpu-pathtracer, `_colorBackground` is instantiated as a
 * GradientEquirectTexture whose constructor defaults `topColor` to 0xffffff,
 * but without generating the procedural texture data (Float32Array buffer remains
 * all zeros, i.e. black). When `updateEnvironment()` compares
 * `!colorBackground.topColor.equals(scene.background)`, a requested white
 * (0xffffff) matches the ungenerated topColor, skipping `update()`.
 *
 * This function guarantees that if `scene.background` is a Color, the internal
 * background texture data is populated with the matching scene background,
 * preserving pure white, pure black, and arbitrary colors without mutating scene data.
 *
 * @param {object} pathTracer Instance of WebGLPathTracer.
 */
export function ensurePathTracerEnvironment(pathTracer) {
    if (!pathTracer) return;
    const scene = pathTracer.scene;
    if (!scene || !scene.background || !scene.background.isColor) return;

    if (typeof pathTracer.updateEnvironment === 'function') {
        pathTracer.updateEnvironment();
    }

    const colorBg = pathTracer._colorBackground;
    if (colorBg && typeof colorBg.update === 'function') {
        const data = colorBg.image?.data;
        // If data is all zero but topColor is white (or matches background),
        // the constructor defaulted topColor without generating texture data. Force update.
        if (data && data[0] === 0 && data[1] === 0 && data[2] === 0) {
            const bg = scene.background;
            if (bg.r !== 0 || bg.g !== 0 || bg.b !== 0) {
                colorBg.topColor.copy(bg);
                colorBg.bottomColor.copy(bg);
                colorBg.update();
                if (pathTracer._pathTracer?.material) {
                    pathTracer._pathTracer.material.backgroundMap = colorBg;
                }
            }
        }
    }
}
