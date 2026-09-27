import { 
    DirectionalLight, 
    PointLight 
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
            console.log("[upgrade lights]: light-",child);
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
    
    if (lightsToAdd.length > 0) {
        console.log(`Upgraded ${lightsToAdd.length} placeholder lights.`);
        console.log(lightsToAdd)
    }

    return globalIllumination;
}