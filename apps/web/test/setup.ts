import { configure } from '@testing-library/dom';

// findBy… and waitFor give up after 1 s by default. `pnpm test` runs the web tests next to the
// api's Testcontainers suite, and under that load a page that loads in two steps (locations, then
// its data) can need longer: tests then failed only in full runs. A real failure still fails, just
// later.
configure({ asyncUtilTimeout: 5_000 });
