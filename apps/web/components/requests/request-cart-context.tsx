'use client';

import type { RequestAvailability, RequestDestination, RequestWarehouse } from '@durby/shared';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useAuth } from '../../app/providers';
import {
  type Cart,
  cartLines,
  cartStorageKey,
  type CartUnits,
  parseStoredCart,
  unitsStorageKey,
} from '../../lib/orders/request-cart';
import {
  loadAvailability,
  loadRequestDestinations,
  loadRequestWarehouses,
} from '../../lib/orders/requests-api';
import type { Resource } from '../../lib/use-resource';
import { useResource } from '../../lib/use-resource';
import { useCartUnits } from './cart-controls';

/** Where a branch's request goes: its branch and the warehouse that supplies it (ADR 0067), else the main one. */
export interface CartRoute {
  branch: RequestDestination;
  source: RequestWarehouse;
}

export interface RequestCart {
  /** null while loading, or when there is nowhere to ask (no branch, no supplying warehouse). */
  route: Resource<CartRoute | null>;
  /** What the supplying warehouse offers, with what it has. */
  offered: Resource<RequestAvailability[]>;
  reloadOffered: () => void;
  cart: Cart;
  setCart: (next: (cart: Cart) => Cart) => void;
  units: CartUnits;
  setUnit: (itemId: string, unit: 'box' | 'piece') => void;
  /** The cart's lines among what is offered. */
  lines: ReturnType<typeof cartLines>;
}

const Context = createContext<RequestCart | null>(null);

/** The request cart of a branch on Inventory (ADR 0065), or null outside its provider. */
export const useRequestCart = () => useContext(Context);

/**
 * One request cart for the Inventory page (ADR 0065): the category's rows add to it and the header's Request Cart
 * shows and sends it, so its count follows every click. Kept in the browser per organization and branch, the same
 * cart as Request stock's.
 */
export function RequestCartProvider({
  organizationId,
  children,
}: {
  organizationId: string;
  children: ReactNode;
}) {
  const { store } = useAuth();
  const [warehouses] = useResource(organizationId, () => loadRequestWarehouses(store));
  const [destinations] = useResource(organizationId, () => loadRequestDestinations(store));
  const route = routeOf(warehouses, destinations);
  const ready = route.status === 'ready' ? route.data : null;
  const [offered, reloadOffered] = useResource(
    ready ? `${organizationId}:${ready.source.id}` : null,
    () => loadAvailability(store, ready!.source.id),
  );
  const locationId = ready?.branch.locationId ?? 'none';
  const key = cartStorageKey(organizationId, locationId);
  const [cart, setCartState] = useState<Cart>(() => (ready ? readCart(key) : {}));
  const [cartKey, setCartKey] = useState(ready ? key : null);
  if (ready && cartKey !== key) {
    setCartKey(key);
    setCartState(readCart(key));
  }
  useEffect(() => {
    if (cartKey === null) return;
    try {
      localStorage.setItem(cartKey, JSON.stringify(cart));
    } catch {
      // Private mode or blocked storage: the cart lives only on this page.
    }
  }, [cartKey, cart]);
  const [units, setUnit] = useCartUnits(unitsStorageKey(organizationId, locationId));
  const value: RequestCart = {
    route,
    offered,
    reloadOffered,
    cart,
    setCart: (next) => setCartState((c) => next(c)),
    units,
    setUnit,
    lines: cartLines(cart, offered.status === 'ready' ? offered.data : []),
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function routeOf(
  warehouses: Resource<RequestWarehouse[]>,
  destinations: Resource<RequestDestination[]>,
): Resource<CartRoute | null> {
  if (warehouses.status !== 'ready') return warehouses;
  if (destinations.status !== 'ready') return destinations;
  const branch = destinations.data[0];
  const source =
    warehouses.data.find((w) => w.id === branch?.supplierWarehouseId) ??
    warehouses.data.find((w) => w.isMain);
  return { status: 'ready', data: branch && source ? { branch, source } : null };
}

function readCart(key: string): Cart {
  try {
    return parseStoredCart(localStorage.getItem(key));
  } catch {
    return {};
  }
}
