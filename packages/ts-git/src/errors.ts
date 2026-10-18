export class TsGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TsGitError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends TsGitError {
  public readonly code = 'ENOENT';
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

export class AlreadyExistsError extends TsGitError {
  public readonly code = 'EEXIST';
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'AlreadyExistsError';
    this.path = path;
  }
}

export class NotADirectoryError extends TsGitError {
  public readonly code = 'ENOTDIR';
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'NotADirectoryError';
    this.path = path;
  }
}

export class IsADirectoryError extends TsGitError {
  public readonly code = 'EISDIR';
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'IsADirectoryError';
    this.path = path;
  }
}

export class DirectoryNotEmptyError extends TsGitError {
  public readonly code = 'ENOTEMPTY';
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'DirectoryNotEmptyError';
    this.path = path;
  }
}

export class InvalidRefError extends TsGitError {
  public readonly code = 'EINVALIDREF';
  public readonly ref?: string;

  constructor(message: string, ref?: string) {
    super(message);
    this.name = 'InvalidRefError';
    this.ref = ref;
  }
}

export class InvalidObjectTypeError extends TsGitError {
  public readonly code = 'EINVALIDOBJECTTYPE';
  public readonly type?: string;

  constructor(message: string, type?: string) {
    super(message);
    this.name = 'InvalidObjectTypeError';
    this.type = type;
  }
}

export class ObjectNotFoundError extends NotFoundError {
  public readonly oid?: string;

  constructor(message: string, oid?: string) {
    super(message);
    this.name = 'ObjectNotFoundError';
    this.oid = oid;
  }
}

export class IndexParseError extends TsGitError {
  public readonly code = 'EINDEXPARSE';

  constructor(message: string) {
    super(message);
    this.name = 'IndexParseError';
  }
}

export class MergeConflictError extends TsGitError {
  public readonly code = 'EMERGECONFLICT';
  public readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(message);
    this.name = 'MergeConflictError';
    this.paths = paths;
  }
}

export class EmptyCommitError extends TsGitError {
  public readonly code = 'EEMPTYCOMMIT';

  constructor(message: string = 'Cannot create an empty commit') {
    super(message);
    this.name = 'EmptyCommitError';
  }
}

export class DetachedHeadError extends TsGitError {
  public readonly code = 'EDETACHEDHEAD';

  constructor(
    message: string = 'Cannot perform operation in detached HEAD state',
  ) {
    super(message);
    this.name = 'DetachedHeadError';
  }
}

export class InvalidPathError extends TsGitError {
  public readonly code = 'EINVALIDPATH';
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'InvalidPathError';
    this.path = path;
  }
}

export class ConfigParseError extends TsGitError {
  public readonly code = 'ECONFIGPARSE';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

export class NotAGitRepoError extends TsGitError {
  public readonly code = 'ENOTGITREPO';
  public readonly path?: string;

  constructor(message: string = 'not a git repository', path?: string) {
    super(message);
    this.name = 'NotAGitRepoError';
    this.path = path;
  }
}

export class InvalidGitDirError extends TsGitError {
  public readonly code = 'EINVALIDGITDIR';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidGitDirError';
  }
}

/**
 * A checkout / reset / fast-forward would overwrite local changes or untracked
 * files (git: "Your local changes to the following files would be overwritten
 * by checkout" / "The following untracked working tree files would be
 * overwritten by checkout"). Nothing has been modified when this is thrown.
 */
export class CheckoutConflictError extends TsGitError {
  public readonly code = 'ECHECKOUTCONFLICT';
  /** Tracked paths with local (staged or unstaged) changes in the way. */
  public readonly paths: string[];
  /** Untracked paths that would be overwritten or removed. */
  public readonly untracked: string[];

  constructor(message: string, paths: string[] = [], untracked: string[] = []) {
    super(message);
    this.name = 'CheckoutConflictError';
    this.paths = paths;
    this.untracked = untracked;
  }
}

/** The index has unmerged entries (git: "you need to resolve your current index first"). */
export class UnmergedPathsError extends TsGitError {
  public readonly code = 'EUNMERGED';
  public readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(message);
    this.name = 'UnmergedPathsError';
    this.paths = paths;
  }
}
