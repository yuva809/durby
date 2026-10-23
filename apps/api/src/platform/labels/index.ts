// Public API of platform/labels: the tenant's resolved labels and translators (emails, PDFs,
// exports). Overrides change through the HTTP API only.
export { labelsErrors } from './labels-errors';
export { LabelService } from './labels.service';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { LabelsModule } from './labels.module';
