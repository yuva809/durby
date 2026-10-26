import type { TypeB } from './type-cycle-b';

export interface TypeA {
  b?: TypeB;
}
