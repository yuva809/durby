// (h) root → platform and root → module index.ts: allowed
import { core } from './platform/core';
import { alpha } from './modules/alpha';

export const appModule = `${core}-${alpha}`;
