import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, PerspectiveCamera, type WebGLRenderer } from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { renderOverlay } from '../src/client/overlay.js';

test('battery saver draws hands without clearing the world already rendered', () => {
  const world = new Scene();
  const hands = new Scene();
  const camera = new PerspectiveCamera();
  const visible: Scene[] = [];
  let depthClears = 0;
  const renderer = {
    autoClear: true,
    clearDepth() { depthClears++; },
    render(scene: Scene) {
      if (this.autoClear) visible.length = 0;
      visible.push(scene);
    },
  };
  const effect = new OutlineEffect(renderer as unknown as WebGLRenderer);
  effect.enabled = false;
  effect.render(world, camera);
  renderOverlay(renderer, () => effect.render(hands, camera));
  assert.deepEqual(visible, [world, hands]);
  assert.equal(depthClears, 1);
  assert.equal(renderer.autoClear, true, 'the next world frame can clear normally');
});

test('a failed overlay draw restores the renderer for the next frame', () => {
  const renderer = { autoClear: true, clearDepth() {} };
  assert.throws(() => renderOverlay(renderer, () => { throw new Error('draw failed'); }), /draw failed/);
  assert.equal(renderer.autoClear, true);
});
