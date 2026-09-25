type Saved = { y: number; panes: Record<string, number> };

let pending: Saved | null = null;

const capture = (): Saved => {
  const panes: Record<string, number> = {};
  for (const pane of document.querySelectorAll<HTMLElement>('[data-scroll-id]')) panes[pane.dataset.scrollId!] = pane.scrollTop;
  return { y: window.scrollY, panes };
};

export const keepScrollOnNextSwap = () => {
  pending = capture();
};

// see docs/web-ui.md#scroll
export function installScrollKeeping() {
  document.addEventListener('astro:before-preparation', (e) => {
    if (e.navigationType === 'traverse') return;
    if (e.sourceElement?.closest('[data-keep-scroll]')) keepScrollOnNextSwap();
  });
  document.addEventListener('astro:after-swap', () => {
    if (!pending) return;
    for (const [id, top] of Object.entries(pending.panes)) {
      const pane = document.querySelector<HTMLElement>(`[data-scroll-id="${id}"]`);
      if (pane) pane.scrollTop = top;
    }
    window.scrollTo({ left: 0, top: pending.y, behavior: 'instant' });
    pending = null;
  });
}
