import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { buildTerrainMesh } from './terrainMesh';

interface Scene3DProps {
    lat: number;
    lon: number;
    /** Which body the scene is following. For a lunar eclipse the position props below describe
     *  the Moon rather than the Sun, and the sky has to be lit accordingly: a lunar eclipse only
     *  ever happens at night, so driving the sky colour and light intensity off the body's
     *  altitude (correct for the Sun) would paint a bright blue midday sky around it. */
    mode?: 'solar' | 'lunar';
    /** Degrees; 0=N, 90=E, clockwise. */
    sunAzimuth: number;
    /** Degrees above the horizontal. */
    sunAltitude: number;
    /** Sun's diameter fraction covered by the Moon; can exceed 1 during totality. */
    magnitude: number;
    inCentralEclipse: boolean;
    /** 0 (first contact) to 1 (last contact): which side of the Sun the Moon is currently
     *  crossing from. Magnitude alone is symmetric in time (rises then falls), so it can only
     *  drive how *close* the Moon is, not which side it's on — without this the Moon would
     *  appear to reverse back out the way it came instead of sliding through in one direction. */
    progress: number;
}

const EYE_HEIGHT_M = 1.7;
const SUN_DISTANCE_M = 20000;
const MOON_DISTANCE_M = SUN_DISTANCE_M * 0.96;
const SUN_DIAMETER_M = 620;
const MOON_DIAMETER_M = 660;
const SKY_RADIUS_M = 50000;
const STAR_COUNT = 2500;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** World frame is x=east, y=up, z=south (east × up = south) — a right-handed frame so
 *  cross-product-derived directions (camera look controls, the Moon's offset across the Sun)
 *  come out at the correct real-world compass angle instead of mirrored.
 *
 *  `out` defaults to a fresh Vector3 for one-off callers (e.g. the setup effect's initial look
 *  direction); the prop-application effect below passes its own persistent scratch instead, since
 *  it re-runs on every tick of a dragged time slider. */
function sunDirection(azimuthDeg: number, altitudeDeg: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const az = (azimuthDeg * Math.PI) / 180;
    const alt = (altitudeDeg * Math.PI) / 180;
    return out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
}

/** Rough sky colour by sun altitude: daytime blue -> sunset amber -> twilight/night blue-grey.
 *  Writes into `out` and returns it (instead of allocating a fresh THREE.Color) — this runs once
 *  per prop-application effect invocation, which fires on every tick of a dragged time slider, so
 *  a slider drag was allocating several short-lived Color objects per frame for no benefit. `tmp`
 *  is scratch space for the lerp target, also caller-owned so this function itself allocates
 *  nothing. */
function horizonColorFor(altitudeDeg: number, out: THREE.Color, tmp: THREE.Color): THREE.Color {
    if (altitudeDeg > 10) return out.set('#bfe3fa');
    if (altitudeDeg > 0) {
        const t = altitudeDeg / 10;
        return out.set('#f2b06b').lerp(tmp.set('#bfe3fa'), t);
    }
    if (altitudeDeg > -8) {
        const t = (altitudeDeg + 8) / 8;
        return out.set('#33405f').lerp(tmp.set('#f2b06b'), t);
    }
    return out.set('#12172a');
}

function zenithColorFor(altitudeDeg: number, out: THREE.Color, tmp: THREE.Color): THREE.Color {
    if (altitudeDeg > 10) return out.set('#4a90d9');
    if (altitudeDeg > 0) {
        const t = altitudeDeg / 10;
        return out.set('#9a6a9e').lerp(tmp.set('#4a90d9'), t);
    }
    if (altitudeDeg > -8) {
        const t = (altitudeDeg + 8) / 8;
        return out.set('#0b0f24').lerp(tmp.set('#9a6a9e'), t);
    }
    return out.set('#04050c');
}

/** How visible stars should be: twilight/night darkness, boosted during totality (the sky
 *  visibly darkens even when the Sun's geometric altitude isn't that low). */
function starsOpacityFor(altitudeDeg: number, inCentralEclipse: boolean): number {
    const fromDarkness = Math.max(0, Math.min(1, (-altitudeDeg - 2) / 10));
    return Math.max(fromDarkness, inCentralEclipse ? 0.6 : 0);
}

/** Non-null: some hardened browser configurations (aggressive canvas-fingerprinting
 *  protection, or a context budget exhausted by many prior textures) can return null here.
 *  Throwing a clear message beats the cryptic "Cannot read properties of null" a bare
 *  non-null assertion would produce a few lines further down. */
function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable — cannot build 3D scene textures');
    return ctx;
}

function createDiscTexture(color: string): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = get2dContext(canvas);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return new THREE.CanvasTexture(canvas);
}

function createGlowTexture(innerColor: string): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = get2dContext(canvas);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, innerColor);
    gradient.addColorStop(0.35, innerColor);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}

function createStarTexture(): THREE.CanvasTexture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = get2dContext(canvas);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}

function buildSkyDome(): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
    const geometry = new THREE.SphereGeometry(SKY_RADIUS_M, 32, 16);
    const material = new THREE.ShaderMaterial({
        uniforms: {
            horizonColor: { value: new THREE.Color('#bfe3fa') },
            zenithColor: { value: new THREE.Color('#4a90d9') },
        },
        vertexShader: `
            varying vec3 vDir;
            void main() {
                vDir = normalize(position);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 horizonColor;
            uniform vec3 zenithColor;
            varying vec3 vDir;
            void main() {
                float h = clamp(vDir.y, 0.0, 1.0);
                vec3 color = mix(horizonColor, zenithColor, smoothstep(0.0, 0.6, h));
                gl_FragColor = vec4(color, 1.0);
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -1;
    return { mesh, material };
}

function buildStars(): { points: THREE.Points; material: THREE.PointsMaterial } {
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
        // Points on the upper hemisphere of a sphere, biased slightly toward the zenith.
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 0.9);
        const r = SKY_RADIUS_M * 0.98;
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.cos(phi);
        positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
        size: 220,
        map: createStarTexture(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        sizeAttenuation: true,
        fog: false,
    });
    return { points: new THREE.Points(geometry, material), material };
}

export function Scene3D({ lat, lon, mode = 'solar', sunAzimuth, sunAltitude, magnitude, inCentralEclipse, progress }: Scene3DProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
    const ambientRef = useRef<THREE.HemisphereLight | null>(null);
    const sunGlowRef = useRef<THREE.Sprite | null>(null);
    const sunDiscRef = useRef<THREE.Sprite | null>(null);
    const moonDiscRef = useRef<THREE.Sprite | null>(null);
    const coronaRef = useRef<THREE.Sprite | null>(null);
    const skyMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
    const starsMaterialRef = useRef<THREE.PointsMaterial | null>(null);
    const fogRef = useRef<THREE.Fog | null>(null);
    // Static most of the time (nothing moves unless the user drags/zooms or a prop changes) —
    // rendering every frame regardless was burning GPU/battery on an unchanged image the whole
    // time the 3D tab was left open. Read/written across both effects and the RAF loop below.
    const needsRenderRef = useRef(true);
    // Bumped by the scene-setup effect every time it (re)builds the scene (currently only on a
    // [lat, lon] change). The prop-application effect below depends on it so props always get
    // reapplied to the new light/sprite objects after a rebuild, regardless of what triggered
    // it — otherwise a rebuild that isn't also accompanied by a change in the second effect's own
    // deps would leave the new objects at their just-constructed defaults. Currently unreachable
    // in practice (Scene3DPanel unmounts this component while terrain is loading, which is
    // exactly when lat/lon changes), but latent — this closes that gap regardless of what future
    // callers do.
    const [sceneEpoch, setSceneEpoch] = useState(0);
    // Scratch objects reused across every prop-application effect run instead of allocating fresh
    // THREE.Vector3/Color instances each time — that effect re-runs on every tick of a dragged
    // time slider, so this avoids GC churn during a drag (the same rationale as `lookScratch` /
    // `lookTargetScratch` in the setup effect below).
    const dirScratchRef = useRef(new THREE.Vector3());
    const sunPosScratchRef = useRef(new THREE.Vector3());
    const rightScratchRef = useRef(new THREE.Vector3());
    const moonPosScratchRef = useRef(new THREE.Vector3());
    const horizonColorScratchRef = useRef(new THREE.Color());
    const zenithColorScratchRef = useRef(new THREE.Color());
    const colorLerpScratchRef = useRef(new THREE.Color());
    const nightColorScratchRef = useRef(new THREE.Color());

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        const fog = new THREE.Fog('#bfe3fa', 2000, 9000);
        scene.fog = fog;
        fogRef.current = fog;

        const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.5, 100000);
        camera.position.set(0, EYE_HEIGHT_M, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // Recomputing a 2048x2048 shadow depth buffer is the single most expensive part of a
        // frame — freeze it to only happen on demand (via `shadowMap.needsUpdate`, set below
        // whenever the sun direction/geometry actually changes) instead of every frame forever.
        renderer.shadowMap.autoUpdate = false;
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // --- First-person look-around: drag to rotate the view from this fixed point,
        // wheel to zoom the field of view. (OrbitControls orbits a camera around a target;
        // here the camera itself must stay put, so it's driven directly instead.)
        const lookDir = sunDirection(sunAzimuth, sunAltitude);
        let yaw = Math.atan2(lookDir.x, -lookDir.z);
        let pitch = Math.asin(Math.max(-1, Math.min(1, lookDir.y)));

        // Reused across every applyLook() call instead of allocating fresh Vector3s each time —
        // this runs at native pointermove rate while dragging.
        const lookScratch = new THREE.Vector3();
        const lookTargetScratch = new THREE.Vector3();
        const applyLook = () => {
            lookScratch.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw));
            camera.lookAt(lookTargetScratch.copy(camera.position).add(lookScratch));
            needsRenderRef.current = true;
        };
        applyLook();

        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        const onPointerDown = (e: PointerEvent) => {
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            renderer.domElement.setPointerCapture(e.pointerId);
        };
        const onPointerMove = (e: PointerEvent) => {
            if (!dragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            // Content-follows-cursor feel (like Street View / most click-drag panorama
            // viewers), not FPS mouselook: dragging right/down slides the view as if you
            // were dragging the sky itself, rather than steering your gaze that way.
            yaw -= dx * 0.005;
            pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.005));
            applyLook();
        };
        const releaseCaptureIfHeld = (e: PointerEvent) => {
            // hasPointerCapture guard: releasePointerCapture throws NotFoundError if this
            // element doesn't currently hold capture for the pointer (e.g. a pointerup that
            // arrives after a pointercancel already released it), which would otherwise leave
            // dragging permanently stuck at whatever it was set to below.
            if (renderer.domElement.hasPointerCapture(e.pointerId)) {
                renderer.domElement.releasePointerCapture(e.pointerId);
            }
        };
        const onPointerUp = (e: PointerEvent) => {
            dragging = false;
            releaseCaptureIfHeld(e);
        };
        // A pointercancel (browser reclaims the pointer mid-drag — an interrupted touch gesture,
        // e.g.) doesn't fire pointerup. Without handling it, `dragging` stays true forever and
        // the view then rotates on plain hover instead of only while actively dragging.
        const onPointerCancel = (e: PointerEvent) => {
            dragging = false;
            releaseCaptureIfHeld(e);
        };
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            camera.fov = Math.max(20, Math.min(75, camera.fov + e.deltaY * 0.02));
            camera.updateProjectionMatrix();
            needsRenderRef.current = true;
        };
        renderer.domElement.style.touchAction = 'none';
        renderer.domElement.style.cursor = 'grab';
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('pointercancel', onPointerCancel);
        renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

        const { mesh: skyDome, material: skyMaterial } = buildSkyDome();
        scene.add(skyDome);
        skyMaterialRef.current = skyMaterial;

        const { points: stars, material: starsMaterial } = buildStars();
        scene.add(stars);
        starsMaterialRef.current = starsMaterial;

        const ambient = new THREE.HemisphereLight('#cfe8ff', '#3a3226', 0.6);
        scene.add(ambient);
        ambientRef.current = ambient;

        const sunLight = new THREE.DirectionalLight('#fff4e0', 2);
        sunLight.castShadow = true;
        sunLight.shadow.mapSize.set(2048, 2048);
        sunLight.shadow.camera.left = -5500;
        sunLight.shadow.camera.right = 5500;
        sunLight.shadow.camera.top = 5500;
        sunLight.shadow.camera.bottom = -5500;
        sunLight.shadow.camera.near = 100;
        sunLight.shadow.camera.far = 60000;
        sunLight.shadow.bias = -0.0015;
        scene.add(sunLight);
        scene.add(sunLight.target);
        sunLightRef.current = sunLight;

        const sunGlow = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: createGlowTexture('#fff6d8'),
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                transparent: true,
                fog: false,
            }),
        );
        sunGlow.scale.set(SUN_DIAMETER_M * 3, SUN_DIAMETER_M * 3, 1);
        scene.add(sunGlow);
        sunGlowRef.current = sunGlow;

        const corona = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: createGlowTexture('rgba(255,255,255,0.9)'),
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                transparent: true,
                opacity: 0,
                fog: false,
            }),
        );
        corona.scale.set(SUN_DIAMETER_M * 2.4, SUN_DIAMETER_M * 2.4, 1);
        scene.add(corona);
        coronaRef.current = corona;

        const sunDisc = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: createDiscTexture('#fff6d8'), depthWrite: false, transparent: true, fog: false }),
        );
        sunDisc.scale.set(SUN_DIAMETER_M, SUN_DIAMETER_M, 1);
        scene.add(sunDisc);
        sunDiscRef.current = sunDisc;

        const moonDisc = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: createDiscTexture('#050505'), depthWrite: false, transparent: true, fog: false }),
        );
        moonDisc.scale.set(MOON_DIAMETER_M, MOON_DIAMETER_M, 1);
        scene.add(moonDisc);
        moonDiscRef.current = moonDisc;

        // Bumped once the new scene's ref objects (sunLightRef, ambientRef, etc. above) are all
        // in place. The prop-application effect below depends on this, so a scene rebuild always
        // gets its lighting/sun-position props reapplied afterward — otherwise a rebuild triggered
        // by something other than that effect's own deps (currently only [lat, lon], which never
        // changes prop values themselves) would leave the new light/sprite objects at their
        // just-constructed defaults instead of the current props.
        setSceneEpoch((epoch) => epoch + 1);

        let disposed = false;
        let terrainMesh: THREE.Mesh | null = null;

        buildTerrainMesh(lat, lon)
            .then((data) => {
                if (disposed) return;
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
                geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
                geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
                geometry.computeVertexNormals();

                const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
                terrainMesh = new THREE.Mesh(geometry, material);
                terrainMesh.receiveShadow = true;
                terrainMesh.castShadow = true;
                scene.add(terrainMesh);
                renderer.shadowMap.needsUpdate = true;
                needsRenderRef.current = true;
            })
            .catch((err: unknown) => {
                console.error('Failed to build terrain mesh for the 3D view', err);
            });

        let frame = 0;
        const animate = () => {
            frame = requestAnimationFrame(animate);
            if (!needsRenderRef.current) return;
            needsRenderRef.current = false;
            renderer.render(scene, camera);
        };
        animate();

        const resize = () => {
            if (!container) return;
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
            needsRenderRef.current = true;
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);

        return () => {
            disposed = true;
            rendererRef.current = null;
            cancelAnimationFrame(frame);
            resizeObserver.disconnect();
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('pointercancel', onPointerCancel);
            renderer.domElement.removeEventListener('wheel', onWheel);

            terrainMesh?.geometry.dispose();
            (terrainMesh?.material as THREE.Material | undefined)?.dispose();

            skyDome.geometry.dispose();
            skyMaterial.dispose();
            stars.geometry.dispose();
            starsMaterial.map?.dispose();
            starsMaterial.dispose();
            ambient.dispose();
            sunLight.dispose();
            sunLight.shadow.map?.dispose();
            for (const sprite of [sunGlow, corona, sunDisc, moonDisc]) {
                sprite.material.map?.dispose();
                sprite.material.dispose();
            }

            renderer.dispose();
            // dispose() only frees three.js's own CPU-side caches (geometries, programs, render
            // lists) — it does NOT release the underlying WebGL context. Scene3D remounts on
            // every tab entry and every point click while the 3D tab is open, so without this the
            // browser accumulates one live GL context per mount until it starts forcibly killing
            // older ones (Chrome's context-limit eviction), which then breaks whichever scene was
            // still using it.
            renderer.forceContextLoss();
            container.removeChild(renderer.domElement);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lat, lon]);

    useEffect(() => {
        const light = sunLightRef.current;
        const ambient = ambientRef.current;
        const sunGlow = sunGlowRef.current;
        const sunDisc = sunDiscRef.current;
        const moonDisc = moonDiscRef.current;
        const corona = coronaRef.current;
        const skyMaterial = skyMaterialRef.current;
        const starsMaterial = starsMaterialRef.current;
        const fog = fogRef.current;
        if (!light || !ambient || !sunGlow || !sunDisc || !moonDisc || !corona || !skyMaterial || !starsMaterial || !fog) return;

        const dir = sunDirection(sunAzimuth, sunAltitude, dirScratchRef.current);
        const sunPos = sunPosScratchRef.current.copy(dir).multiplyScalar(SUN_DISTANCE_M);
        light.position.copy(sunPos);
        light.target.position.set(0, 0, 0);
        light.target.updateMatrixWorld();
        sunGlow.position.copy(sunPos);
        sunDisc.position.copy(sunPos);
        corona.position.copy(sunPos);

        const right = rightScratchRef.current.crossVectors(dir, WORLD_UP).normalize();
        const sunRadius = SUN_DIAMETER_M / 2;
        const moonRadius = MOON_DIAMETER_M / 2;
        const offsetMagnitude = Math.max(0, 1 - Math.min(magnitude, 1)) * (sunRadius + moonRadius);
        const side = progress < 0.5 ? 1 : -1;
        moonDisc.position.copy(
            moonPosScratchRef.current.copy(dir).multiplyScalar(MOON_DISTANCE_M).addScaledVector(right, offsetMagnitude * side),
        );

        const aboveHorizon = sunAltitude > -1;
        const lunar = mode === 'lunar';

        if (lunar) {
            // Moonlight, not sunlight: enough to shape the terrain, far too little to light the
            // sky. Dimmed further through totality, when the Moon reddens and loses most of its
            // brightness — magnitude here is how deep into Earth's shadow it has gone.
            const shadowed = Math.max(0, Math.min(1, magnitude));
            light.intensity = aboveHorizon ? 0.35 * (1 - 0.75 * shadowed) : 0;
            // The ambient term has to come down with it. Left at its daytime 0.6 (and its daytime
            // sky-blue colour) it dominated the 0.35 moonlight completely, so the terrain rendered
            // as a bright overcast afternoon under a night sky full of stars — the single most
            // wrong-looking thing about the lunar scene, and invisible in the sky colours alone.
            // Not taken all the way down, though, and raised further when the Moon is below the
            // horizon: the directional light is 0 there, so with only a night-level fill left the
            // frame came out completely black, reading as "the 3D view is broken" rather than as
            // "it's dark here". Half the planet is in that state during any lunar eclipse, so it
            // is the common case, not an edge one — the scene still has to show the terrain the
            // user came to look at.
            ambient.intensity = (aboveHorizon ? 0.2 : 0.55) * (1 - 0.45 * shadowed);
            ambient.color.set('#2b3c5e');
            ambient.groundColor.set('#0d1018');
            sunGlow.visible = false; // no solar glow at night
            corona.visible = false; // a solar corona has no lunar equivalent
            moonDisc.visible = false; // nothing occults the Moon from the observer's side
            sunDisc.visible = aboveHorizon;
            // The disc itself goes from bright white to the copper of a totally eclipsed Moon.
            (sunDisc.material as THREE.SpriteMaterial).color.setRGB(1, 1 - 0.45 * shadowed, 1 - 0.72 * shadowed);

            const night = nightColorScratchRef.current.set('#05070f');
            // buildSkyDome() above always constructs uniforms with exactly these two keys; the
            // ShaderMaterial type's index-signature typing for `uniforms` doesn't carry that
            // certainty through to this call site.
            skyMaterial.uniforms.horizonColor!.value = horizonColorScratchRef.current.set('#0b1020');
            skyMaterial.uniforms.zenithColor!.value = night;
            starsMaterial.opacity = 1;
            fog.color = night;
        } else {
            light.intensity = aboveHorizon ? Math.max(0.15, Math.sin((Math.max(sunAltitude, 0) * Math.PI) / 180) * 2 + 0.3) : 0;
            // Restored explicitly rather than assumed untouched: the lunar branch above mutates
            // this same shared light, so switching lunar → solar has to put it back.
            ambient.intensity = 0.6;
            ambient.color.set('#cfe8ff');
            ambient.groundColor.set('#3a3226');
            sunGlow.visible = aboveHorizon;
            corona.visible = true;
            sunDisc.visible = aboveHorizon;
            moonDisc.visible = aboveHorizon;
            (sunDisc.material as THREE.SpriteMaterial).color.setRGB(1, 1, 1);
            (corona.material as THREE.SpriteMaterial).opacity = inCentralEclipse ? 0.8 : 0;

            const horizonColor = horizonColorFor(sunAltitude, horizonColorScratchRef.current, colorLerpScratchRef.current);
            const zenithColor = zenithColorFor(sunAltitude, zenithColorScratchRef.current, colorLerpScratchRef.current);
            skyMaterial.uniforms.horizonColor!.value = horizonColor;
            skyMaterial.uniforms.zenithColor!.value = zenithColor;
            starsMaterial.opacity = starsOpacityFor(sunAltitude, inCentralEclipse);
            fog.color = horizonColor;
        }

        // Sun/Moon/sky just moved — request the next frame, and let the (now on-demand) shadow
        // map catch up to the new light direction/position.
        const renderer = rendererRef.current;
        if (renderer) renderer.shadowMap.needsUpdate = true;
        needsRenderRef.current = true;
    }, [mode, sunAzimuth, sunAltitude, magnitude, inCentralEclipse, progress, sceneEpoch]);

    return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
