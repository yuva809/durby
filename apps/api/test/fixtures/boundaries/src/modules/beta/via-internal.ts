// (b) module → other module's internal file: disallowed
import { x } from '../alpha/internal/x';

export const viaInternal = x;
