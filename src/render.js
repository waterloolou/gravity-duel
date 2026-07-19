import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import * as P from "./physics.js";

const TRAJECTORY_PREVIEW_TICKS = 120; // ~4s forward, purely visual -- never affects the real shot

// Colors are deliberately punchy/saturated (not physically toned-down) --
// UnrealBloomPass's threshold means only bright, saturated materials glow,
// so the "which things read as energy/light sources" palette choice here is
// what actually drives the bloom look, not scene lighting (there is none;
// everything gameplay-relevant is self-lit MeshBasicMaterial, same reasoning
// as the original build -- see the r155+ physical-light-units note below).
const OWN_COLOR = 0x5be8ff;
const ENEMY_COLOR = 0xff3d5a;
const WELL_COLOR = 0xffb454;

function makeCanvasTexture(size, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A cheap equirectangular-style gradient + soft color blobs + baked dust,
// mapped onto the inside of a giant BackSide sphere -- a standard low-cost
// skybox trick that avoids fetching any external texture asset (keeping the
// same zero-external-asset ethos as the inline SVG favicon).
function makeNebulaTexture() {
  return makeCanvasTexture(512, (ctx, size) => {
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, "#050308");
    grad.addColorStop(0.32, "#140b2e");
    grad.addColorStop(0.5, "#2c1656");
    grad.addColorStop(0.68, "#160c34");
    grad.addColorStop(1, "#040308");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const blobColors = ["rgba(124,58,237,0.28)", "rgba(56,140,255,0.20)", "rgba(255,120,90,0.10)"];
    for (let i = 0; i < 16; i++) {
      const cx = Math.random() * size;
      const cy = size * 0.2 + Math.random() * size * 0.6;
      const r = 40 + Math.random() * 150;
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, blobColors[i % blobColors.length]);
      rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < 240; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const s = Math.random() < 0.15 ? 1.6 : 0.7;
      ctx.globalAlpha = 0.25 + Math.random() * 0.5;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, s, s);
    }
    ctx.globalAlpha = 1;
  });
}

function makeStarfield(count, minR, maxR) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [
    [1, 1, 1],
    [0.72, 0.82, 1],
    [1, 0.86, 0.72],
    [0.78, 0.92, 1],
  ];
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = minR + Math.random() * (maxR - minR);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    const c = palette[(Math.random() * palette.length) | 0];
    const b = 0.5 + Math.random() * 0.5;
    colors[i * 3] = c[0] * b;
    colors[i * 3 + 1] = c[1] * b;
    colors[i * 3 + 2] = c[2] * b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 3.2,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  return new THREE.Points(geometry, material);
}

// One flat delta-wing triangle, authored directly in the ship's own local
// space (nose at -Z, tail at +Z -- see the body/tail geometry rotation notes
// below for why that convention was chosen). `sign` mirrors it to the
// opposite side.
function makeWingGeometry(sign) {
  const R = P.SHIP_RADIUS;
  const verts = new Float32Array([
    sign * 0.15 * R, 0, -0.2 * R,
    sign * 1.6 * R, 0, 0.9 * R,
    sign * 0.15 * R, 0, 1.3 * R,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  return geometry;
}

// Object3D.lookAt() fully overwrites the target's rotation/quaternion each
// call based solely on position + target -- it does NOT compose with any
// rotation set beforehand. That means baking orientation into a mesh's own
// `.rotation` (as the original single-cone ship did) is silently discarded
// the moment lookAt() runs. Baking it into the GEOMETRY's vertex data via
// .rotateX() instead survives lookAt() every frame, since lookAt only ever
// rotates the parent Group -- the geometry itself never moves relative to
// that Group. lookAt's convention is "local -Z points at the target", so
// every part here is authored with the nose at -Z and the tail/engine at +Z.
function buildShipGeometries() {
  const body = new THREE.ConeGeometry(P.SHIP_RADIUS * 0.65, P.SHIP_RADIUS * 3.4, 6);
  body.rotateX(-Math.PI / 2);
  const tail = new THREE.CylinderGeometry(P.SHIP_RADIUS * 0.5, P.SHIP_RADIUS * 0.58, P.SHIP_RADIUS * 1.1, 6);
  tail.rotateX(Math.PI / 2);
  const engine = new THREE.SphereGeometry(P.SHIP_RADIUS * 0.42, 10, 10);
  return { body, tail, engine, wingL: makeWingGeometry(1), wingR: makeWingGeometry(-1) };
}

function createShipModel(geo, hullColor, engineColor) {
  const group = new THREE.Group();

  const hullMat = new THREE.MeshBasicMaterial({ color: hullColor });
  const invulnMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const wingMat = new THREE.MeshBasicMaterial({ color: hullColor, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const invulnWingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });

  const body = new THREE.Mesh(geo.body, hullMat);
  const tail = new THREE.Mesh(geo.tail, hullMat);
  tail.position.z = P.SHIP_RADIUS * 1.6;
  const wingL = new THREE.Mesh(geo.wingL, wingMat);
  const wingR = new THREE.Mesh(geo.wingR, wingMat);

  const engineMat = new THREE.MeshBasicMaterial({
    color: engineColor,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const engine = new THREE.Mesh(geo.engine, engineMat);
  engine.position.z = P.SHIP_RADIUS * 2.15;

  group.add(body, tail, wingL, wingR, engine);

  let engineIntensity = 0.35;
  return {
    group,
    setInvulnerable(isInvuln) {
      const solidMat = isInvuln ? invulnMat : hullMat;
      const flatMat = isInvuln ? invulnWingMat : wingMat;
      body.material = solidMat;
      tail.material = solidMat;
      wingL.material = flatMat;
      wingR.material = flatMat;
    },
    setThrusting(isThrusting) {
      const target = isThrusting ? 1 : 0.3;
      engineIntensity += (target - engineIntensity) * 0.15;
      engine.scale.setScalar(0.7 + engineIntensity * 0.85);
      engineMat.opacity = 0.3 + engineIntensity * 0.65;
    },
  };
}

export function createRenderer(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05050a);

  const camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.5, 4200);
  const baseFov = camera.fov;

  // preserveDrawingBuffer: true -- without it, headless browser automation
  // (screenshots, canvas.toDataURL() readback) can capture an already-
  // cleared buffer instead of the just-rendered frame, since the browser is
  // otherwise free to clear the drawing buffer immediately after each
  // frame's presentation. Confirmed by direct pixel sampling during this
  // project's earlier verification passes.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // --- backdrop: nebula skybox + starfield --------------------------------
  const nebulaMesh = new THREE.Mesh(
    new THREE.SphereGeometry(3200, 32, 24),
    new THREE.MeshBasicMaterial({ map: makeNebulaTexture(), side: THREE.BackSide, depthWrite: false })
  );
  scene.add(nebulaMesh);
  scene.add(makeStarfield(3500, 900, 3000));

  // --- gravity well: core + corona + a tilted, layered accretion disk ----
  // Deliberately MeshBasicMaterial (unlit), not an emissive MeshStandardMaterial
  // -- Three.js r155+ switched point/directional lights to physically-correct
  // (candela) intensity units by default, which made old-style low intensity
  // values (2-3) render as near-total black; rather than chase exact physical
  // unit conversions for a stylized arcade game, every gameplay-critical
  // object here is fully self-lit so visibility never depends on getting
  // scene lighting tuned right.
  const wellMesh = new THREE.Mesh(
    new THREE.SphereGeometry(P.WELL_RADIUS, 32, 32),
    new THREE.MeshBasicMaterial({ color: WELL_COLOR })
  );
  scene.add(wellMesh);

  const coronaMesh = new THREE.Mesh(
    new THREE.SphereGeometry(P.WELL_RADIUS * 1.35, 24, 24),
    new THREE.MeshBasicMaterial({
      color: 0xff9944,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  scene.add(coronaMesh);

  const diskGroup = new THREE.Group();
  diskGroup.rotation.x = Math.PI / 2.6;
  const ringSpecs = [
    { inner: 1.3, outer: 1.9, color: 0xffcf8a, opacity: 0.55 },
    { inner: 1.9, outer: 2.8, color: 0xff9a4d, opacity: 0.3 },
    { inner: 2.8, outer: 4.2, color: 0xb066ff, opacity: 0.14 },
  ];
  for (const { inner, outer, color, opacity } of ringSpecs) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(P.WELL_RADIUS * inner, P.WELL_RADIUS * outer, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    diskGroup.add(mesh);
  }
  scene.add(diskGroup);

  // Arena boundary, for spatial reference only -- a faint energy-dome read
  // rather than a plain wireframe ball.
  const arenaMesh = new THREE.Mesh(
    new THREE.SphereGeometry(P.ARENA_RADIUS, 32, 20),
    new THREE.MeshBasicMaterial({ color: 0x4488ff, wireframe: true, transparent: true, opacity: 0.08 })
  );
  scene.add(arenaMesh);

  // First-person camera means the local player's own ship is never rendered
  // (it's always exactly at the camera) -- only the opponent needs a model.
  const shipGeo = buildShipGeometries();
  const opponentShip = createShipModel(shipGeo, OWN_COLOR, 0xffffff);
  scene.add(opponentShip.group);

  // Projectiles: a short glowing "bolt" (stretched cylinder) oriented along
  // its own velocity, one mesh per live projectile id, created/disposed as
  // they appear/vanish. Counts stay small, so no pooling is needed.
  const projectileGeometry = new THREE.CylinderGeometry(P.PROJECTILE_RADIUS * 0.8, P.PROJECTILE_RADIUS * 0.8, P.PROJECTILE_RADIUS * 7, 6);
  const ownProjectileMaterial = new THREE.MeshBasicMaterial({ color: OWN_COLOR });
  const enemyProjectileMaterial = new THREE.MeshBasicMaterial({ color: ENEMY_COLOR });
  const projectileMeshes = new Map();

  // Trajectory preview: a dashed ghost line showing where the LOCAL ship
  // would drift under current input, forward-simulated client-side with the
  // exact same integrator the server uses. Purely visual -- the real shot is
  // independently simulated server-side regardless of what this line shows.
  const trajectoryGeometry = new THREE.BufferGeometry();
  const trajectoryMaterial = new THREE.LineDashedMaterial({ color: OWN_COLOR, dashSize: 8, gapSize: 5, transparent: true, opacity: 0.5 });
  const trajectoryLine = new THREE.Line(trajectoryGeometry, trajectoryMaterial);
  scene.add(trajectoryLine);

  // --- particle VFX: muzzle flashes + death explosions --------------------
  const muzzleFlashes = [];
  const explosionBursts = [];

  function spawnMuzzleFlash(pos, color) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(P.SHIP_RADIUS * 0.9, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    mesh.position.copy(pos);
    scene.add(mesh);
    muzzleFlashes.push({ mesh, age: 0, life: 0.15 });
  }

  function spawnExplosion(pos, color) {
    const count = 46;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const dir = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
      dir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      const speed = 40 + Math.random() * 100;
      velocities[i * 3] = dir.x * speed;
      velocities[i * 3 + 1] = dir.y * speed;
      velocities[i * 3 + 2] = dir.z * speed;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color,
      size: 5,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    explosionBursts.push({ points, positions, velocities, age: 0, life: 0.9, material });
  }

  function updateMuzzleFlashes(dt) {
    for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
      const f = muzzleFlashes[i];
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) {
        scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        muzzleFlashes.splice(i, 1);
        continue;
      }
      f.mesh.scale.setScalar(1 + t * 1.5);
      f.mesh.material.opacity = 1 - t;
    }
  }

  function updateExplosions(dt) {
    for (let i = explosionBursts.length - 1; i >= 0; i--) {
      const b = explosionBursts[i];
      b.age += dt;
      const t = b.age / b.life;
      if (t >= 1) {
        scene.remove(b.points);
        b.points.geometry.dispose();
        b.material.dispose();
        explosionBursts.splice(i, 1);
        continue;
      }
      for (let j = 0; j < b.positions.length; j += 3) {
        b.positions[j] += b.velocities[j] * dt;
        b.positions[j + 1] += b.velocities[j + 1] * dt;
        b.positions[j + 2] += b.velocities[j + 2] * dt;
        b.velocities[j] *= 0.94;
        b.velocities[j + 1] *= 0.94;
        b.velocities[j + 2] *= 0.94;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
      b.material.opacity = 1 - t;
    }
  }

  // --- camera: base transform + additive shake + thrust FOV kick ---------
  const baseCamPos = new THREE.Vector3();
  const baseCamFacing = new THREE.Vector3(0, 0, 1);
  let shakeTrauma = 0;
  let localThrusting = false;

  function updateCamera(selfShip) {
    baseCamPos.set(selfShip.pos[0], selfShip.pos[1], selfShip.pos[2]);
    const facing = P.facingFromYawPitch(selfShip.yaw, selfShip.pitch);
    baseCamFacing.set(facing.x, facing.y, facing.z);
  }

  function triggerShake(amount) {
    shakeTrauma = Math.min(1, shakeTrauma + amount);
  }

  function setLocalThrust(isThrusting) {
    localThrusting = isThrusting;
  }

  function updateOpponent(oppShip) {
    opponentShip.group.position.set(oppShip.pos[0], oppShip.pos[1], oppShip.pos[2]);
    const facing = P.facingFromYawPitch(oppShip.yaw, oppShip.pitch);
    opponentShip.group.lookAt(
      opponentShip.group.position.x + facing.x,
      opponentShip.group.position.y + facing.y,
      opponentShip.group.position.z + facing.z
    );
    opponentShip.setInvulnerable(!!oppShip.invulnerable);
    opponentShip.setThrusting(!!oppShip.thrusting);
  }

  function updateProjectiles(projectiles, selfId, onSpawn) {
    const seen = new Set();
    for (const p of projectiles) {
      seen.add(p.id);
      let mesh = projectileMeshes.get(p.id);
      const isOwn = p.ownerId === selfId;
      if (!mesh) {
        mesh = new THREE.Mesh(projectileGeometry, isOwn ? ownProjectileMaterial : enemyProjectileMaterial);
        scene.add(mesh);
        projectileMeshes.set(p.id, mesh);
        const pos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]);
        spawnMuzzleFlash(pos, isOwn ? OWN_COLOR : ENEMY_COLOR);
        onSpawn?.(p);
      }
      mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
      if (p.vel) {
        const vLenSq = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1] + p.vel[2] * p.vel[2];
        if (vLenSq > 1e-6) {
          mesh.lookAt(mesh.position.x + p.vel[0], mesh.position.y + p.vel[1], mesh.position.z + p.vel[2]);
        }
      }
    }
    for (const [id, mesh] of projectileMeshes) {
      if (seen.has(id)) continue;
      scene.remove(mesh);
      projectileMeshes.delete(id);
    }
  }

  function updateTrajectoryPreview(selfShip, thrusting) {
    let sim = {
      pos: { x: selfShip.pos[0], y: selfShip.pos[1], z: selfShip.pos[2] },
      vel: { x: selfShip.vel[0], y: selfShip.vel[1], z: selfShip.vel[2] },
    };
    const input = { aimYaw: selfShip.yaw, aimPitch: selfShip.pitch, thrusting };
    const points = [new THREE.Vector3(sim.pos.x, sim.pos.y, sim.pos.z)];
    for (let i = 0; i < TRAJECTORY_PREVIEW_TICKS; i++) {
      const stepped = P.integrateShip(sim, P.TICK_DT, input);
      sim = { pos: stepped.pos, vel: stepped.vel };
      points.push(new THREE.Vector3(sim.pos.x, sim.pos.y, sim.pos.z));
    }
    trajectoryGeometry.setFromPoints(points);
    trajectoryLine.computeLineDistances();
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(canvas.clientWidth || 1, canvas.clientHeight || 1),
    0.85, // strength
    0.55, // radius
    0.72 // threshold -- only saturated/bright self-lit materials bloom, not the dim starfield/nebula backdrop
  );
  composer.addPass(bloomPass);

  const clock = new THREE.Clock();

  function render() {
    const dt = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.getElapsedTime();

    diskGroup.rotation.z += dt * 0.15;
    wellMesh.scale.setScalar(1 + 0.03 * Math.sin(elapsed * 2.2));
    coronaMesh.scale.setScalar(1 + 0.06 * Math.sin(elapsed * 1.5));

    updateMuzzleFlashes(dt);
    updateExplosions(dt);

    shakeTrauma = Math.max(0, shakeTrauma - dt * 2.2);
    if (shakeTrauma > 0) {
      const mag = shakeTrauma * shakeTrauma * 14;
      camera.position.set(
        baseCamPos.x + (Math.random() * 2 - 1) * mag,
        baseCamPos.y + (Math.random() * 2 - 1) * mag,
        baseCamPos.z + (Math.random() * 2 - 1) * mag
      );
    } else {
      camera.position.copy(baseCamPos);
    }
    camera.lookAt(baseCamPos.x + baseCamFacing.x, baseCamPos.y + baseCamFacing.y, baseCamPos.z + baseCamFacing.z);

    const targetFov = localThrusting ? baseFov + 6 : baseFov;
    camera.fov += (targetFov - camera.fov) * 0.08;
    camera.updateProjectionMatrix();

    composer.render();
  }

  return {
    resize,
    updateCamera,
    updateOpponent,
    updateProjectiles,
    updateTrajectoryPreview,
    spawnExplosion,
    triggerShake,
    setLocalThrust,
    render,
  };
}
