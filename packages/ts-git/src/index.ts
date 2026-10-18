// Core exports (platform-agnostic)
export * from './core/index.js';
export * from './core/objects.js';
export * from './core/refs.js';
export * from './core/config.js';
export * from './commands/index.js';
export * from './types.js';
export * from './errors.js';

// Utility exports
export * from './utils/walk.js';
export * from './utils/gitignore.js';
export { normalizeRepoRelativePath, relative } from './utils/path.js';

// FS types only (implementations are platform-specific)
export {
  type FSAdapter,
  type FSAdapterOptions,
  type DirEntry,
  type FileStats,
} from './fs/types.js';

export * from './client/index.js';

// Remote transports and protocol building blocks
export {
  HttpTransport,
  LocalTransport,
  createTransport,
  type GitTransport,
  type HttpTransportOptions,
  type LocalTransportOptions,
  type FetchPackRequest,
  type FetchPackResult,
  type PushPackRequest,
} from './remote/transport.js';
export {
  createFetchHttpClient,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type GitAuth,
  type AuthCallback,
  type AuthFailureCallback,
} from './remote/http.js';
export { parseRefspec, formatRefspec, type Refspec } from './remote/refspec.js';
export type {
  RefAdvertisement,
  RemoteRef,
  PushCommand,
  PushReport,
} from './remote/protocol.js';
export {
  createPackfile,
  indexPackfile,
  storePackfile,
} from './core/pack-builder.js';
export { mergeFile, type MergeFileResult } from './core/merge-file.js';
export { isAncestor, findMergeBases } from './core/commit-graph.js';
