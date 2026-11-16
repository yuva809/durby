// Default en labels, one file per key prefix (docs/platform/labels.md, ADR 0022).
import auth from './auth.json';
import billing from './billing.json';
import catalog from './catalog.json';
import inventory from './inventory.json';
import orders from './orders.json';
import platform from './platform.json';
import pos from './pos.json';
import reports from './reports.json';
import reservations from './reservations.json';
import staff from './staff.json';

/** Every label file of this locale, by key prefix (checked in index.test.ts). */
export const labelFiles = {
  auth,
  billing,
  catalog,
  inventory,
  orders,
  platform,
  pos,
  reports,
  reservations,
  staff,
};

/** The whole dictionary: the files never share a key (index.test.ts). */
export default {
  ...auth,
  ...billing,
  ...catalog,
  ...inventory,
  ...orders,
  ...platform,
  ...pos,
  ...reports,
  ...reservations,
  ...staff,
};
