// src/viewer/Model3DView.jsx — 3D 模型预览（three.js + VRMLLoader.parse）
// 场景搭建/归一化/取景逻辑移植自 eehubio/kicad_part_viewer（init3D/normalizeModel/fitCameraToObject）
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLLoader } from 'three/addons/loaders/VRMLLoader.js';

function normalizeModel(obj) {
  const root = new THREE.Group();
  root.add(obj);
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error('模型无可见几何体');
  let center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -box.min.y, -center.z);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  root.scale.setScalar(5 / maxDim);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  return root;
}

function fitCamera(object, camera, controls, padding = 1.35) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center.clone();
  const radius = Math.max(sphere.radius, 0.01);
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * padding;
  const dir = new THREE.Vector3(1, 0.75, 1).normalize();
  controls.target.copy(center);
  camera.position.copy(center).add(dir.multiplyScalar(distance));
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance + radius * 30;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  controls.update();
  controls.saveState();
}

export default function Model3DView({ wrlText }) {
  const hostRef = useRef(null);
  const stateRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f9fc);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    camera.position.set(4, 3, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.2));
    const dl = new THREE.DirectionalLight(0xffffff, 2);
    dl.position.set(5, 8, 6);
    scene.add(dl);
    scene.add(new THREE.GridHelper(10, 20, 0xb8c2d2, 0xe2e7ef));

    const resize = () => {
      const w = host.clientWidth || 600, h = host.clientHeight || 380;
      renderer.setSize(w, h);              // 默认 updateStyle=true：CSS 尺寸=逻辑尺寸，绘图缓冲按 pixelRatio 放大
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const st = stateRef.current;
      if (st?.root) fitCamera(st.root, camera, controls);   // 容器尺寸变化后重新取景
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    window.addEventListener('resize', resize);
    resize();
    let running = true;
    (function loop() {
      if (!running) return;
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    })();
    stateRef.current = { scene, camera, controls, renderer, root: null };
    return () => {
      running = false;
      ro.disconnect();
      window.removeEventListener('resize', resize);
      controls.dispose();
      renderer.dispose();
      host.innerHTML = '';
      stateRef.current = null;
    };
  }, []);

  useEffect(() => {
    const st = stateRef.current;
    if (!st || !wrlText) return;
    if (st.root) {
      st.scene.remove(st.root);
      st.root.traverse?.((o) => {
        o.geometry?.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      st.root = null;
    }
    try {
      const obj = new VRMLLoader().parse(wrlText, '');
      st.root = normalizeModel(obj);
      st.scene.add(st.root);
      requestAnimationFrame(() => fitCamera(st.root, st.camera, st.controls));
    } catch (e) {
      console.error('WRL 解析失败', e);
    }
  }, [wrlText]);

  return <div ref={hostRef} className="model3d-host" />;
}
