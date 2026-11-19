import { refresh } from './motion/motion.js';
import * as moments from './moments/moments.js';
import fx from './effects/fx.js';

let home;

function mount() {
  const next = document.querySelector('.studio-home');
  if (!next || home === next) return;
  if (home) unmount();
  home = next;
  refresh();
  moments.mountAll(home);
  fx.mountAll(home, { bg: '#e5ece7', ink: '#1b352d', accent: '#a9c7b7' });
}

function unmount() {
  if (!home) return;
  moments.unmountAll(home);
  fx.unmountAll(home);
  home = undefined;
}

window.addEventListener('pixel-studio:home', mount);
window.addEventListener('pixel-studio:leave-home', unmount);
mount();
