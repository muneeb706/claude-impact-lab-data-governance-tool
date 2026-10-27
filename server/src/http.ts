import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, type ApiError } from '../../shared/types';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

/** Express 4 does not catch rejected promises, so async handlers forward them to the error handler. */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));
export const nameSchema = z.string().trim().min(1, 'Name is required').max(120);
export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200);

// Keyed by the column list in SQLite's "UNIQUE constraint failed: ..." message.
const UNIQUE_VIOLATIONS: Record<string, ApiError> = {
  'accounts.name': { error: 'An account with this name already exists', field: 'name' },
  'users.email': { error: 'A user with this email already exists', field: 'email' },
  'managers.email': { error: 'An account manager with this email already exists', field: 'email' },
  'policies.code': { error: 'A policy with this code already exists', field: 'code' },
  'datasets.account_id, datasets.name': { error: 'This account already has a dataset with that name', field: 'name' },
  'roles.name, roles.account_type': {
    error: 'A role with this name already exists for this account type',
    field: 'name',
  },
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let status = 500;
  let body: ApiError = { error: 'Internal server error' };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: err.message, field: err.field };
  } else if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    status = 400;
    body = { error: issue.message, field: issue.path.join('.') || undefined };
  } else if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const columns = String(err.message).replace('UNIQUE constraint failed: ', '');
    const known = UNIQUE_VIOLATIONS[columns];
    status = 409;
    body = known ?? { error: 'A record with that value already exists' };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { error: 'The upload is too large' };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { error: 'Malformed JSON body' };
  } else {
    console.error(err);
  }

  res.status(status).json(body);
};
