import * as THREE from "three";
import * as P from "./physics.js";

const TRAJECTORY_PREVIEW_TICKS = 120; // ~4s forward, purely visual -- never affects the real shot

export function createRenderer(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05050a);

  const camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.5, 3000);

  // preserveDrawingBuffer: true -- without it, headless browser automation
  // (screenshots, canvas.toDataURL() readback) can capture an already-
  // cleared buffer instead of the just-rendered frame, since the browser is
  // otherwise free to clear the drawing buffer immediately after each
  // frame's presentation. Confirmed by direct pixel sampling: without this,
  // the real running game's canvas read back as 100% black/transparent
  // (alpha=0 on every pixel) despite camera/scene/geometry all being
  // independently verified correct.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // The gravity well: a self-lit sun sphere. Deliberately MeshBasicMaterial
  // (unlit), not an emissive MeshStandardMaterial -- Three.js r155+ switched
  // point/directional lights to physically-correct (candela) intensity units
  // by default, which made old-style low intensity values (2-3) render as
  // near-total black; rather than chase exact physical unit conversions for
  // a stylized arcade game, every gameplay-critical object here is fully
  // self-lit so visibility never depends on getting scene lighting tuned
  // right -- verified by a screenshot that was solid black before this fix.
  const wellMesh = new THREE.Mesh(
    new THREE.SphereGeometry(P.WELL_RADIUS, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xff8833 })
  );
  scene.add(wellMesh);

  // Arena boundary, for spatial reference only.
  const arenaMesh = new THREE.Mesh(
    new THREE.SphereGeometry(P.ARENA_RADIUS, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x5577ff, wireframe: true, transparent: true, opacity: 0.12 })
  );
  scene.add(arenaMesh);

  // Opponent ship. First-person camera means the local player's own ship is
  // never rendered (it's always exactly at the camera). Self-lit for the
  // same reason as the well -- instant visibility matters more than PBR
  // shading in a fast-paced competitive game.
  const opponentMesh = new THREE.Mesh(
    new THREE.ConeGeometry(P.SHIP_RADIUS, P.SHIP_RADIUS * 3, 8),
    new THREE.MeshBasicMaterial({ color: 0x66ccff })
  );
  opponentMesh.rotation.x = Math.PI / 2; // cone's local +Y becomes local +Z, matching facingFromYawPitch's convention
  scene.add(opponentMesh);
  const opponentInvulnMaterial = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.35 });
  const opponentSolidMaterial = opponentMesh.material;

  // Projectiles: one mesh per live projectile id, created/disposed as they
  // appear/vanish. Counts stay small (a handful in flight at once), so no
  // pooling is needed for this scope.
  const projectileGeometry = new THREE.SphereGeometry(P.PROJECTILE_RADIUS, 8, 8);
  const ownProjectileMaterial = new THREE.MeshBasicMaterial({ color: 0x99ffcc });
  const enemyProjectileMaterial = new THREE.MeshBasicMaterial({ color: 0xff8899 });
  const projectileMeshes = new Map();

  // Trajectory preview: a dashed ghost line showing where the LOCAL ship
  // would drift under current input, forward-simulated client-side with the
  // exact same integrator the server uses. Purely visual -- the real shot is
  // independently simulated server-side regardless of what this line shows.
  const trajectoryGeometry = new THREE.BufferGeometry();
  const trajectoryMaterial = new THREE.LineDashedMaterial({ color: 0x88ffaa, dashSize: 6, gapSize: 4 });
  const trajectoryLine = new THREE.Line(trajectoryGeometry, trajectoryMaterial);
  scene.add(trajectoryLine);

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function updateCamera(selfShip) {
    camera.position.set(selfShip.pos[0], selfShip.pos[1], selfShip.pos[2]);
    const facing = P.facingFromYawPitch(selfShip.yaw, selfShip.pitch);
    camera.lookAt(camera.position.x + facing.x, camera.position.y + facing.y, camera.position.z + facing.z);
  }

  function updateOpponent(oppShip) {
    opponentMesh.position.set(oppShip.pos[0], oppShip.pos[1], oppShip.pos[2]);
    const facing = P.facingFromYawPitch(oppShip.yaw, oppShip.pitch);
    opponentMesh.lookAt(
      opponentMesh.position.x + facing.x,
      opponentMesh.position.y + facing.y,
      opponentMesh.position.z + facing.z
    );
    opponentMesh.material = oppShip.invulnerable ? opponentInvulnMaterial : opponentSolidMaterial;
  }

  function updateProjectiles(projectiles, selfId) {
    const seen = new Set();
    for (const p of projectiles) {
      seen.add(p.id);
      let mesh = projectileMeshes.get(p.id);
      if (!mesh) {
        mesh = new THREE.Mesh(projectileGeometry, p.ownerId === selfId ? ownProjectileMaterial : enemyProjectileMaterial);
        scene.add(mesh);
        projectileMeshes.set(p.id, mesh);
      }
      mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
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

  function render() {
    renderer.render(scene, camera);
  }

  return { resize, updateCamera, updateOpponent, updateProjectiles, updateTrajectoryPreview, render };
}
