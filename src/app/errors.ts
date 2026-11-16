export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 3,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export function invalid(message: string, details?: unknown): never {
  throw new AppError('INVALID_ARGUMENT', message, 2, details);
}

export function failure(error: unknown) {
  if (error instanceof AppError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'INVALID_PROJECT' || code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return new AppError('INVALID_ARGUMENT', message, 2);
  }
  if ((error as { errcode?: number } | null)?.errcode === 5) return new AppError('BUSY', message);
  return new AppError('OPERATION_FAILED', message);
}
