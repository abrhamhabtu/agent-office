/** Draw first-person objects over the world, including when outlines are disabled. */
export function renderOverlay(renderer: { autoClear: boolean; clearDepth(): void }, draw: () => void): void {
  const autoClear = renderer.autoClear;
  renderer.clearDepth();
  renderer.autoClear = false;
  try {
    draw();
  } finally {
    renderer.autoClear = autoClear;
  }
}
