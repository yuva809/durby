import type { TypeA } from './type-cycle-a';

export interface TypeB {
  a?: TypeA;
}
