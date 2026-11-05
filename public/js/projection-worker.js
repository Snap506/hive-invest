/* Runs the projection off the main thread so the screen never stutters. */
import { project } from './projection.js';
self.onmessage = e => self.postMessage({ key: e.data.key, r: project(e.data.args) });
