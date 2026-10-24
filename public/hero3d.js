// Hero visual: a chrome infinity loop with a blue band, rendered in WebGL.
// Falls back silently to the static SVG if WebGL or the module CDN is unavailable.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const host = document.querySelector('.visual');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function start() {
  const canvas = document.createElement('canvas');
  canvas.className = 'gl-canvas';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 2, 0.1, 100);
  camera.position.set(0, 0, 11);

  // Lemniscate with depth so the two strands pass over each other at the crossing
  class Loop extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const a = t * Math.PI * 2;
      const d = 1 + Math.sin(a) ** 2;
      const lobe = 1 + 0.16 * Math.cos(a); // right lobe slightly larger, like the reference
      return target.set((3.1 * Math.cos(a) / d) * lobe, (1.55 * Math.sin(a) * Math.cos(a) / d) * lobe, 0.55 * Math.sin(a));
    }
  }
  const tubular = 420, radial = 56;
  const geo = new THREE.TubeGeometry(new Loop(), tubular, 0.42, radial, true);

  // Vertex colours: silver chrome with a blue-violet band sweeping across one lobe
  const colors = new Float32Array(geo.attributes.position.count * 3);
  const silver = new THREE.Color('#f1f2f7'), blue = new THREE.Color('#2a3cff'), violet = new THREE.Color('#8f7bff');
  const c = new THREE.Color();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    const band = Math.exp(-((t - 0.78) ** 2) / 0.006) + 0.85 * Math.exp(-((t - 0.32) ** 2) / 0.004);
    c.copy(silver).lerp(t > 0.55 ? blue : violet, Math.min(1, band));
    for (let j = 0; j <= radial; j++) {
      const k = (i * (radial + 1) + j) * 3;
      colors[k] = c.r; colors[k + 1] = c.g; colors[k + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, metalness: 0.55, roughness: 0.18, envMapIntensity: 1.9,
    clearcoat: 1, clearcoatRoughness: 0.08, iridescence: 0.25, iridescenceIOR: 1.4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const group = new THREE.Group();
  group.add(mesh);
  scene.add(group);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3f5, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 6, 8); scene.add(key);
  const rim = new THREE.PointLight(0x3a4dff, 40, 30); rim.position.set(3, -2, 4); scene.add(rim);
  const fill = new THREE.PointLight(0x9f8cff, 18, 30); fill.position.set(-4, 2, 3); scene.add(fill);

  host.appendChild(canvas);
  host.classList.add('gl');

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w < 640 ? 13 : 9.6;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(host);

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', e => {
    mouse.tx = (e.clientX / innerWidth - 0.5) * 2;
    mouse.ty = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });

  let visible = true, raf = 0;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) loop(); }).observe(host);

  const clock = new THREE.Clock();
  function render(t) {
    mouse.x += (mouse.tx - mouse.x) * 0.05;
    mouse.y += (mouse.ty - mouse.y) * 0.05;
    group.rotation.y = Math.sin(t * 0.35) * 0.42 + mouse.x * 0.25;
    group.rotation.x = -0.32 + Math.sin(t * 0.27) * 0.1 + mouse.y * 0.12;
    group.rotation.z = Math.sin(t * 0.2) * 0.05;
    group.position.y = Math.sin(t * 0.8) * 0.12;
    renderer.render(scene, camera);
  }
  function loop() {
    if (!visible) { raf = 0; return; }
    render(clock.getElapsedTime());
    raf = requestAnimationFrame(loop);
  }
  if (reduced) render(0); else loop();
}

try { start(); } catch (e) { /* keep the SVG fallback */ }
