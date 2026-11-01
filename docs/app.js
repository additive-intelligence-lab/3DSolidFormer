import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const palette = {
  displacement: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  strain: ['#ffffcc', '#ffeda0', '#fed976', '#fd8d3c', '#e31a1c', '#800026'],
  stress: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
};
const legend = {
  displacement: ['|u| / L<sub>0</sub>', '0.03', '0.3', '3'],
  strain: ['ε<sub>eq</sub>', '8 × 10⁻³', '0.08', '0.8'],
  stress: ['σ<sub>vm</sub> / E<sub>0</sub>', '8 × 10⁻³', '0.08', '0.8'],
};
const caseCache = new Map();
const viewers = [];
let manifest;

function setStatus(element, message, error = false) {
  const status = element.querySelector('.render-status');
  status.textContent = message;
  status.classList.toggle('error', error);
  status.classList.toggle('hidden', !message);
}

async function loadCase(id) {
  if (caseCache.has(id)) return caseCache.get(id);
  const promise = (async () => {
    const description = manifest.cases.find(c => c.id === id);
    if (!description) throw new Error('Unknown test case.');
    const response = await fetch(`assets/models/${description.file}`);
    if (!response.ok) throw new Error('The test-case file could not be loaded.');
    const buffer = await response.arrayBuffer();
    const arrays = {};
    for (const [name, entry] of Object.entries(description.arrays)) {
      const Typed = entry.type === 'uint32' ? Uint32Array : Float32Array;
      arrays[name] = new Typed(buffer, entry.offset, entry.length);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
    geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1));
    geometry.computeBoundingSphere();
    return { description, geometry, arrays };
  })();
  caseCache.set(id, promise);
  try { return await promise; }
  catch (error) { caseCache.delete(id); throw error; }
}

function coloredGeometry(data, field, kind) {
  const geometry = data.geometry.clone();
  const values = data.arrays[`${field}_${kind}`];
  const colors = new Float32Array(values.length * 3);
  const stops = palette[field].map(hex => new THREE.Color(hex));
  const scale = manifest.fields[field];
  const divisor = Math.log1p(scale.max / scale.q0);
  const neutral = new THREE.Color('#9da9ab');
  const color = new THREE.Color();
  for (let i = 0; i < values.length; i++) {
    const t = THREE.MathUtils.clamp(Math.log1p(Math.max(0, values[i]) / scale.q0) / divisor, 0, 1);
    const position = t * (stops.length - 1);
    const left = Math.min(Math.floor(position), stops.length - 2);
    color.copy(stops[left]).lerp(stops[left + 1], position - left);
    if (data.arrays.support[i] > 0.5) color.copy(neutral);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function makeScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0c1ba, 1.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-3, -4, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(4, 2, 1);
  scene.add(fill);
  return scene;
}

function createViewer(element, dual) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (error) {
    setStatus(element, 'Interactive surface rendering is unavailable in this browser.', true);
    throw error;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.setClearColor(0xf8faf9, 0);
  element.append(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', dual ? 'FEM and model surface fields. Drag to rotate both structures.' : 'Smooth rendering of a topology-optimized structure.');
  const scenes = dual ? [makeScene(), makeScene()] : [makeScene()];
  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = dual;
  controls.minDistance = 3.2;
  controls.maxDistance = 12;
  controls.autoRotate = !dual && !reducedMotion;
  controls.autoRotateSpeed = 0.12;
  if (!dual) controls.enableRotate = false;
  let meshes = [];
  let visible = true;
  let dirty = true;
  let revision = 0;
  let frameNeeded = true;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.67, metalness: 0, side: THREE.DoubleSide });

  function reset() {
    camera.position.set(-3.4, -4.8, -3.4);
    frameNeeded = true;
    controls.target.set(0, 0, 0);
    controls.update();
    dirty = true;
  }
  reset();
  controls.addEventListener('change', () => { dirty = true; });
  new ResizeObserver(() => { dirty = true; }).observe(element);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; dirty = true; }).observe(element);

  async function update(id, field) {
    const current = ++revision;
    setStatus(element, 'Loading the surface…');
    try {
      const data = await loadCase(id);
      if (current !== revision) return;
      for (let i = 0; i < meshes.length; i++) {
        scenes[i].remove(meshes[i]);
        meshes[i].geometry.dispose();
      }
      meshes = scenes.map((scene, i) => {
        const mesh = new THREE.Mesh(coloredGeometry(data, field, dual && i === 0 ? 'fem' : 'prediction'), material);
        scene.add(mesh);
        return mesh;
      });
      setStatus(element, '');
      element.dataset.case = id;
      element.dataset.field = field;
      element.dataset.ready = 'true';
      frameNeeded = true;
      dirty = true;
      return data;
    } catch (error) {
      setStatus(element, 'Surface data could not be loaded.', true);
      console.error(error);
    }
  }

  function render() {
    if (!visible || document.hidden || (!dirty && !controls.autoRotate)) return;
    controls.update();
    const width = Math.round(element.clientWidth);
    const height = Math.round(element.clientHeight);
    if (!width || !height) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) {
      renderer.setSize(width, height, false);
      frameNeeded = true;
    }
    camera.aspect = width / height / scenes.length;
    camera.updateProjectionMatrix();
    if (frameNeeded) {
      camera.position.setLength(Math.max(5.8, 3.6 / camera.aspect));
      controls.update();
      const point = new THREE.Vector3();
      const positions = meshes[0]?.geometry.getAttribute('position');
      if (positions) {
        for (let attempt = 0; attempt < 8; attempt++) {
          camera.updateMatrixWorld();
          let maxX = 0;
          let maxY = 0;
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).project(camera);
            maxX = Math.max(maxX, Math.abs(point.x));
            maxY = Math.max(maxY, Math.abs(point.y));
          }
          const factor = Math.max(maxX / 0.84, maxY / (dual ? 0.68 : 0.85));
          if (factor <= 1) break;
          camera.position.multiplyScalar(factor * 1.02);
          controls.update();
        }
      }
      frameNeeded = false;
    }
    renderer.setScissorTest(true);
    scenes.forEach((scene, i) => {
      const left = Math.round(i * width / scenes.length);
      const right = Math.round((i + 1) * width / scenes.length);
      renderer.setViewport(left, 0, right - left, height);
      renderer.setScissor(left, 0, right - left, height);
      renderer.render(scene, camera);
    });
    dirty = false;
  }
  const viewer = { update, reset, render, controls };
  viewers.push(viewer);
  return viewer;
}

function refreshIcons() { window.lucide?.createIcons(); }

const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  navigation.classList.toggle('open', open);
});
navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  navigation.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', 'Open navigation');
}));

document.querySelector('#copy-citation').addEventListener('click', async () => {
  const text = document.querySelector('.citation-block p').innerText.trim();
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Citation copied.';
  } catch {
    status.textContent = 'Clipboard is unavailable. The complete citation is shown above.';
  }
});

async function start() {
  refreshIcons();
  const response = await fetch('assets/models/manifest.json');
  if (!response.ok) throw new Error('Surface manifest unavailable.');
  manifest = await response.json();
  const comparison = createViewer(document.querySelector('#comparison'), true);
  const select = document.querySelector('#case-select');
  let field = 'stress';
  let request = 0;
  async function updateComparison() {
    const current = ++request;
    const data = await comparison.update(select.value, field);
    if (!data || current !== request) return;
    document.querySelector('#mesh-dimensions').textContent = `${data.description.elements_xyz.join(' × ')} elements`;
    document.querySelector('#field-symbol').innerHTML = legend[field][0];
    for (let i = 1; i <= 3; i++) document.querySelector(`#tick-${i}`).textContent = legend[field][i];
    document.querySelector('#legend-ramp').style.background = `linear-gradient(to right,${palette[field].join(',')})`;
  }
  document.querySelectorAll('.field-tabs button[data-field]').forEach(button => button.addEventListener('click', () => {
    field = button.dataset.field;
    document.querySelectorAll('.field-tabs button[data-field]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    updateComparison();
  }));
  select.addEventListener('change', updateComparison);
  document.querySelector('#reset-view').addEventListener('click', () => comparison.reset());
  document.querySelector('#rotate-view').addEventListener('click', event => {
    const button = event.currentTarget;
    comparison.controls.autoRotate = !comparison.controls.autoRotate;
    button.setAttribute('aria-pressed', String(comparison.controls.autoRotate));
  });
  await updateComparison();
}

function animate() {
  for (const viewer of viewers) viewer.render();
  requestAnimationFrame(animate);
}
animate();
start().catch(error => {
  for (const element of document.querySelectorAll('.hero-stage, .comparison')) {
    setStatus(element, 'Surface data are unavailable.', true);
  }
  console.error(error);
});
window.addEventListener('load', refreshIcons);
