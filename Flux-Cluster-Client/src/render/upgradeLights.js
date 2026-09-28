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

// Colour a pure white world background is nudged to, see worldBackgroundColor.
const WORKAROUND_WHITE = 0xfefefe;

/**
 * Builds the solid background colour for a world GI value.
 *
 * three-gpu-pathtracer keeps a solid scene background in a gradient equirect
 * texture that is created with a white top colour and is only rebuilt when the
 * requested colour differs from the cached one. Because the cached colour is
 * already white, a pure white background is never written into the texture and
 * the tracer resolves the environment to black. Nudging the colour off pure
 * white forces that rebuild; the difference is one of 255 per channel, so the
 * background is indistinguishable.
 *
 * @param {number|import('three').Color} color Hex colour or THREE.Color.
 * @returns {import('three').Color} Background colour for the path tracer.
 */
export function worldBackgroundColor(color) {
    // three's Color constructor defaults to white, so the fallback is explicit.
    const background = new Color(0x000000);

    if (color && color.isColor) {
        background.set(color);
    } else if (color !== undefined && color !== null) {
        background.setRGB(
            ((color >> 16) & 255) / 255,
            ((color >> 8) & 255) / 255,
            (color & 255) / 255
        );
    }

    if (background.r === 1 && background.g === 1 && background.b === 1) {
        background.setHex(WORKAROUND_WHITE);
    }

    return background;
}
