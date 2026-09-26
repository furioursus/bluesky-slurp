// see docs/web-ui.md#sensitive-media
export const BLUR_KEY = 'slurp-blur';
export const blurOn = () => document.documentElement.dataset.blur !== 'off';
