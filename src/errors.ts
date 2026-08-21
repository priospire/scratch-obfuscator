export type ExitCode = 2 | 3 | 4 | 5;

export class AppError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.exitCode = exitCode;
  }
}

export class UsageError extends AppError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export class InputError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 3, options);
    this.name = 'InputError';
  }
}

export class FileSystemError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 4, options);
    this.name = 'FileSystemError';
  }
}
