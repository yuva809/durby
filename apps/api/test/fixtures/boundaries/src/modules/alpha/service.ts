// (f) module → its own internals: allowed; (d) module → platform: allowed
import { core } from '../../platform/core';
import { x } from './internal/x';

export const alpha = `${core}-${x}`;
