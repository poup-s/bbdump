/**
 * Dashboard hero: a stack of three database modules around a light rod, with
 * orbiting rings and rising data particles. Plain three.js (no Vue reactivity in
 * the render loop), loaded on demand by Dashboard3DScene.vue so three.js stays
 * out of the main bundle.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export interface ServerStackOptions {
  dark: boolean;
  reducedMotion: boolean;
  /** Called after the first frame is rendered (to fade the canvas in). */
  onReady?: () => void;
}

/**
 * What the camera frames. The onboarding walks through the stack:
 * top module = "you", middle = "this machine", bottom = "your data",
 * orbit = AI clients (MCP), complete = everything lit.
 */
export type StackFocus = 'overview' | 'top' | 'middle' | 'bottom' | 'orbit' | 'complete';

export interface ServerStackHandle {
  setDark(dark: boolean): void;
  /** Glides the camera to a module / the orbit and lights it (default: overview). */
  setFocus(focus: StackFocus): void;
  dispose(): void;
}

const EMERALD = new THREE.Color('#10b981');
const MODULE_Y = [2, 0, -2];
const RADIUS = 2.2;
const HEIGHT = 0.5;
const PARTICLES = 90;
const LEDS_PER_MODULE = 10;

const palette = (dark: boolean) => ({
  chassis: new THREE.Color(dark ? '#454c57' : '#2b2f36'),
  rod: new THREE.Color(dark ? '#e5e7eb' : '#d4d4d8'),
  orbit: new THREE.Color(dark ? '#52525b' : '#b4b4bb'),
  shadowOpacity: dark ? 0.55 : 0.22,
  envIntensity: dark ? 0.5 : 0.4,
  // Additive glows vanish on a light background: blend normally there
  glowBlending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
});

/** Rounded-edge disc profile for LatheGeometry (bevelled top and bottom rims). */
function chassisGeometry(): THREE.LatheGeometry {
  const r = RADIUS;
  const h = HEIGHT / 2;
  const b = 0.09;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -h), new THREE.Vector2(r - b, -h)];
  const arc = (cx: number, cy: number, from: number, to: number) => {
    for (let i = 1; i <= 8; i++) {
      const a = from + ((to - from) * i) / 8;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * b, cy + Math.sin(a) * b));
    }
  };
  arc(r - b, -h + b, -Math.PI / 2, 0);
  pts.push(new THREE.Vector2(r, h - b));
  arc(r - b, h - b, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(0, h));
  return new THREE.LatheGeometry(pts, 128);
}

/** Soft round sprite for particles and glows, drawn once on a canvas. */
function radialTexture(inner: string, outer: string, size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function ellipse(rx: number, ry: number, material: THREE.LineBasicMaterial): THREE.LineLoop {
  const pts = new THREE.EllipseCurve(0, 0, rx, ry, 0, Math.PI * 2).getPoints(180);
  const geometry = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, 0, p.y)));
  return new THREE.LineLoop(geometry, material);
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function createServerStackScene(canvas: HTMLCanvasElement, options: ServerStackOptions): ServerStackHandle {
  let colors = palette(options.dark);

  // --- Renderer ------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;
  scene.environmentIntensity = colors.envIntensity;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

  // --- Lights (environment does most of the work; these add shape) ---------
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(6, 10, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(-8, 4, -6);
  scene.add(rim);
  const core = new THREE.PointLight(EMERALD, 4, 9, 2);
  scene.add(core);

  // --- Stack ---------------------------------------------------------------
  const root = new THREE.Group();
  scene.add(root);
  const stack = new THREE.Group();
  root.add(stack);

  const chassisGeo = chassisGeometry();
  const chassisMat = new THREE.MeshPhysicalMaterial({
    color: colors.chassis,
    metalness: 0.6,
    roughness: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.25,
  });

  const bandGeo = new THREE.CylinderGeometry(RADIUS + 0.004, RADIUS + 0.004, 0.075, 128, 1, true);
  const haloGeo = new THREE.CylinderGeometry(RADIUS + 0.03, RADIUS + 0.03, 0.3, 128, 1, true);
  const topRingGeo = new THREE.TorusGeometry(RADIUS * 0.72, 0.008, 6, 128);

  const ledGeo = new THREE.BoxGeometry(0.045, 0.035, 0.14);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

  interface Module {
    group: THREE.Group;
    band: THREE.MeshBasicMaterial;
    halo: THREE.MeshBasicMaterial;
    topRing: THREE.MeshBasicMaterial;
    leds: THREE.InstancedMesh;
    ledPhase: number[];
    baseY: number;
  }

  const modules: Module[] = MODULE_Y.map((baseY, index) => {
    const group = new THREE.Group();
    group.position.y = baseY;

    group.add(new THREE.Mesh(chassisGeo, chassisMat));

    const band = new THREE.MeshBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.9, toneMapped: false });
    const bandMesh = new THREE.Mesh(bandGeo, band);
    bandMesh.position.y = -0.04;
    group.add(bandMesh);

    const halo = new THREE.MeshBasicMaterial({
      color: EMERALD, transparent: true, opacity: 0.12, blending: colors.glowBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const haloMesh = new THREE.Mesh(haloGeo, halo);
    haloMesh.position.y = -0.04;
    group.add(haloMesh);

    const topRing = new THREE.MeshBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.25, toneMapped: false });
    const ring = new THREE.Mesh(topRingGeo, topRing);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = HEIGHT / 2 + 0.002;
    group.add(ring);

    const leds = new THREE.InstancedMesh(ledGeo, ledMat, LEDS_PER_MODULE);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < LEDS_PER_MODULE; i++) {
      const a = (i / LEDS_PER_MODULE) * Math.PI * 2 + index * 0.4;
      dummy.position.set(Math.cos(a) * (RADIUS + 0.01), 0.1, Math.sin(a) * (RADIUS + 0.01));
      dummy.rotation.set(0, -a, 0);
      dummy.updateMatrix();
      leds.setMatrixAt(i, dummy.matrix);
      leds.setColorAt(i, EMERALD);
    }
    group.add(leds);

    stack.add(group);
    return {
      group, band, halo, topRing, leds, baseY,
      ledPhase: Array.from({ length: LEDS_PER_MODULE }, () => Math.random() * Math.PI * 2),
    };
  });

  // Central rod: metallic shaft + emerald core + pulses travelling upward
  const rodMat = new THREE.MeshPhysicalMaterial({ color: colors.rod, metalness: 0.9, roughness: 0.2, clearcoat: 1 });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.2, 32), rodMat);
  rod.position.y = 0.3;
  stack.add(rod);
  const coreMat = new THREE.MeshBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.35, toneMapped: false });
  const coreRod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 5.3, 12), coreMat);
  coreRod.position.y = 0.3;
  stack.add(coreRod);

  const glowTexture = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  const pulses = [0, 0.33, 0.66].map(offset => {
    const material = new THREE.SpriteMaterial({
      map: glowTexture, color: EMERALD, transparent: true, blending: colors.glowBlending, depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.55);
    stack.add(sprite);
    return { sprite, material, offset };
  });

  // --- Rising data particles (one Points object) --------------------------
  const particleGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLES * 3);
  const seeds = Array.from({ length: PARTICLES }, () => ({
    y: -3 + Math.random() * 6.5,
    speed: 0.25 + Math.random() * 0.6,
    radius: 1.4 + Math.random() * 2.6,
    angle: Math.random() * Math.PI * 2,
    spin: 0.15 + Math.random() * 0.35,
  }));
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particleMat = new THREE.PointsMaterial({
    size: 0.17, map: glowTexture, color: EMERALD, transparent: true, opacity: 0.9,
    blending: colors.glowBlending, depthWrite: false, sizeAttenuation: true,
  });
  root.add(new THREE.Points(particleGeo, particleMat));

  // --- Orbits --------------------------------------------------------------
  const orbitMat = new THREE.LineBasicMaterial({ color: colors.orbit, transparent: true, opacity: 0.45 });
  const outerPivot = new THREE.Group();
  outerPivot.rotation.set(0.2, 0, -0.14);
  outerPivot.add(ellipse(6.4, 6.4, orbitMat));
  root.add(outerPivot);

  const innerOrbitMat = new THREE.LineBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.35 });
  const innerPivot = new THREE.Group();
  innerPivot.rotation.set(0.08, 0, 0.05);
  innerPivot.position.y = -0.2;
  innerPivot.add(ellipse(3.2, 3.2, innerOrbitMat));
  root.add(innerPivot);

  const satelliteMat = new THREE.SpriteMaterial({
    map: glowTexture, color: EMERALD, transparent: true, blending: colors.glowBlending, depthWrite: false,
  });
  const satellite = new THREE.Sprite(satelliteMat);
  satellite.scale.setScalar(0.4);
  outerPivot.add(satellite);

  // Extra satellites = AI clients joining the orbit (shown for the 'orbit' focus)
  const clientSatMat = new THREE.SpriteMaterial({
    map: glowTexture, color: EMERALD, transparent: true, opacity: 0, blending: colors.glowBlending, depthWrite: false,
  });
  const clientSats = [0.9, 2.3, 3.6, 5.0].map(phase => {
    const sprite = new THREE.Sprite(clientSatMat);
    sprite.scale.setScalar(0.32);
    outerPivot.add(sprite);
    return { sprite, phase };
  });

  // --- Contact shadow ------------------------------------------------------
  const shadowMat = new THREE.MeshBasicMaterial({
    map: radialTexture('rgba(0,0,0,1)', 'rgba(0,0,0,0)', 128),
    transparent: true, opacity: colors.shadowOpacity, depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -2.75;
  root.add(shadow);

  // --- Focus (camera target + which module is lit) ---------------------------
  let focus: StackFocus = 'overview';
  let baseDistance = 20;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const targetPos = new THREE.Vector3();
  const targetLook = new THREE.Vector3();
  const emphasis = [1, 1, 1];
  let orbitLevel = 0;
  let glowBoost = 0;
  const MODULE_INDEX: Partial<Record<StackFocus, number>> = { top: 0, middle: 1, bottom: 2 };

  const computeTargets = () => {
    const moduleIndex = MODULE_INDEX[focus];
    if (moduleIndex !== undefined) {
      const y = MODULE_Y[moduleIndex];
      // Close enough to single out the module, far enough to keep the whole stack in frame
      const d = baseDistance * 0.74;
      targetPos.set(0, y + d * 0.32, d);
      targetLook.set(0, y - 0.1, 0);
    } else if (focus === 'orbit') {
      const d = baseDistance * 1.08;
      targetPos.set(0, d * 0.5, d);
      targetLook.set(0, -0.3, 0);
    } else {
      const d = focus === 'complete' ? baseDistance * 0.95 : baseDistance;
      targetPos.set(0, d * 0.28, d);
      targetLook.set(0, -0.1, 0);
    }
  };
  const emphasisTarget = (i: number) => {
    const moduleIndex = MODULE_INDEX[focus];
    if (moduleIndex !== undefined) return moduleIndex === i ? 1 : 0.18;
    return focus === 'orbit' ? 0.45 : 1;
  };
  const snapToTargets = () => {
    camPos.copy(targetPos);
    camLook.copy(targetLook);
    for (let i = 0; i < 3; i++) emphasis[i] = emphasisTarget(i);
    orbitLevel = focus === 'orbit' || focus === 'complete' ? 1 : 0;
    glowBoost = focus === 'complete' ? 1 : 0;
  };

  // --- Layout --------------------------------------------------------------
  let firstFit = true;
  const fit = () => {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the whole outer orbit in frame on narrow panels
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    baseDistance = Math.max(4.4 / Math.tan(halfV), 6.9 / Math.tan(halfH));
    computeTargets();
    if (firstFit) {
      snapToTargets();
      firstFit = false;
    }
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    camera.updateProjectionMatrix();
  };
  fit();

  // --- Animation -----------------------------------------------------------
  const clock = new THREE.Clock();
  let elapsed = 0;
  let running = false;
  let visible = true;
  let frame = 0;
  let readyFired = false;
  const introDuration = options.reducedMotion ? 0 : 1.4;
  const ledColor = new THREE.Color();

  const update = (dt: number) => {
    elapsed += dt;
    const t = elapsed;
    const motion = options.reducedMotion ? 0 : 1;

    // Glide toward the focus target (exponential smoothing, frame-rate independent)
    const k = motion ? 1 - Math.exp(-dt * 2.4) : 1;
    camPos.lerp(targetPos, k);
    camLook.lerp(targetLook, k);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    for (let i = 0; i < 3; i++) emphasis[i] += (emphasisTarget(i) - emphasis[i]) * k;
    orbitLevel += ((focus === 'orbit' || focus === 'complete' ? 1 : 0) - orbitLevel) * k;
    glowBoost += ((focus === 'complete' ? 1 : 0) - glowBoost) * k;

    // Intro: modules drop into place one after another
    modules.forEach((m, i) => {
      const p = introDuration ? THREE.MathUtils.clamp((t - i * 0.18) / introDuration, 0, 1) : 1;
      const e = easeOutCubic(p);
      m.group.position.y = m.baseY + (1 - e) * 2.5;
      m.group.scale.setScalar(0.92 + 0.08 * e);
      // Data flows top to bottom: each band pulses with a phase offset
      const wave = 0.5 + 0.5 * Math.sin(t * 2.2 - i * 1.1);
      // Focused module fully lit, others dimmed; 'complete' boosts everything
      const lit = e * emphasis[i] * (1 + glowBoost * 0.35);
      m.band.opacity = Math.min(1, (0.55 + 0.45 * wave) * lit);
      m.halo.opacity = (0.06 + 0.14 * wave) * lit * (1 + glowBoost);
      m.topRing.opacity = (0.12 + 0.2 * wave) * lit;
      for (let led = 0; led < LEDS_PER_MODULE; led++) {
        const on = Math.sin(t * (3 + glowBoost * 3) + m.ledPhase[led]) > 0.2 ? 1 : 0.25;
        m.leds.setColorAt(led, ledColor.copy(EMERALD).multiplyScalar(on * lit * 1.6));
      }
      if (m.leds.instanceColor) m.leds.instanceColor.needsUpdate = true;
    });

    stack.rotation.y += dt * 0.18 * motion;
    root.position.y = Math.sin(t * 0.7) * 0.15 * motion;
    // (No rotation of the outer orbit itself: spinning a circle around its normal is
    // invisible, and around any other axis it drifted to vertical after ~30s.
    // The satellites carry the motion.)
    innerPivot.rotation.y -= dt * 0.25 * motion;

    const satAngle = t * 0.35;
    satellite.position.set(Math.cos(satAngle) * 6.4, 0, Math.sin(satAngle) * 6.4);
    clientSatMat.opacity = orbitLevel;
    clientSats.forEach(({ sprite, phase }) => {
      const a = t * 0.35 + phase;
      sprite.position.set(Math.cos(a) * 6.4, 0, Math.sin(a) * 6.4);
    });

    pulses.forEach(({ sprite, material, offset }) => {
      const p = (t * 0.28 + offset) % 1;
      sprite.position.y = -2.3 + p * 5.2;
      material.opacity = Math.sin(p * Math.PI);
    });

    const introAlpha = introDuration ? THREE.MathUtils.clamp((t - 0.4) / introDuration, 0, 1) : 1;
    particleMat.opacity = 0.85 * introAlpha;
    for (let i = 0; i < PARTICLES; i++) {
      const s = seeds[i];
      s.y += s.speed * dt * motion * (1 + glowBoost * 1.5);
      if (s.y > 3.5) s.y = -3;
      s.angle += s.spin * dt * motion;
      positions[i * 3] = Math.cos(s.angle) * s.radius;
      positions[i * 3 + 1] = s.y;
      positions[i * 3 + 2] = Math.sin(s.angle) * s.radius;
    }
    particleGeo.attributes.position.needsUpdate = true;
  };

  const loop = () => {
    if (!running) return;
    frame = requestAnimationFrame(loop);
    update(Math.min(clock.getDelta(), 0.05));
    renderer.render(scene, camera);
    if (!readyFired) {
      readyFired = true;
      options.onReady?.();
    }
  };

  const start = () => {
    if (running || !visible || document.hidden || options.reducedMotion) return;
    running = true;
    clock.getDelta();
    loop();
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(frame);
  };

  if (options.reducedMotion) {
    // One still frame, fully assembled
    update(introDuration + 2);
  } else {
    update(0);
  }
  // Always draw a first frame, even if the window is hidden (e.g. started at login):
  // the canvas can fade in, and the loop starts once the window becomes visible.
  renderer.render(scene, camera);
  readyFired = true;
  options.onReady?.();
  start();

  // Pause when the view is off-screen or the window is hidden
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start(); else stop();
  });
  intersection.observe(canvas);
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);

  const resize = new ResizeObserver(() => {
    fit();
    if (!running) renderer.render(scene, camera);
  });
  resize.observe(canvas);

  return {
    setFocus(next: StackFocus) {
      if (next === focus) return;
      focus = next;
      computeTargets();
      if (!running) {
        // Paused (hidden window / reduced motion): jump straight to the new framing
        snapToTargets();
        update(0);
        renderer.render(scene, camera);
      }
    },
    setDark(dark: boolean) {
      colors = palette(dark);
      chassisMat.color.copy(colors.chassis);
      rodMat.color.copy(colors.rod);
      orbitMat.color.copy(colors.orbit);
      shadowMat.opacity = colors.shadowOpacity;
      scene.environmentIntensity = colors.envIntensity;
      const glows: THREE.Material[] = [particleMat, satelliteMat, clientSatMat, ...pulses.map(p => p.material), ...modules.map(m => m.halo)];
      glows.forEach(material => {
        material.blending = colors.glowBlending;
        material.needsUpdate = true;
      });
      if (!running) renderer.render(scene, camera);
    },
    dispose() {
      stop();
      intersection.disconnect();
      resize.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        materials.forEach(material => {
          const withMap = material as THREE.Material & { map?: THREE.Texture | null };
          withMap.map?.dispose();
          material.dispose();
        });
      });
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
