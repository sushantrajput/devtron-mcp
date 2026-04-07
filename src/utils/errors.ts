// src/utils/errors.ts
// Custom error classes for the MCP server.
// Using specific error types lets us handle failures differently:
//   - DevtronApiError (401) → tell user to check their API token
//   - DevtronConnectionError → tell user Devtron is unreachable
//   - ValidationError → tell user what field is wrong

/**
 * Base class for all errors thrown inside MCP tool handlers.
 * Extends native Error so stack traces work correctly.
 */
export class McpToolError extends Error {
  public readonly code: string;
  public readonly statusCode: number | undefined;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.statusCode = statusCode;

    // Required in TypeScript when extending Error:
    // Without this, `instanceof McpToolError` returns false
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when Devtron's API responds with a non-2xx HTTP status.
 * Examples: 401 (bad token), 404 (app not found), 500 (Devtron internal error)
 */
export class DevtronApiError extends McpToolError {
  constructor(message: string, statusCode: number) {
    super(message, 'DEVTRON_API_ERROR', statusCode);
    this.name = 'DevtronApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the MCP server cannot reach Devtron at all.
 * Examples: DNS failure, network timeout, Devtron pod is down
 */
export class DevtronConnectionError extends McpToolError {
  constructor(message: string) {
    super(message, 'DEVTRON_CONNECTION_ERROR');
    this.name = 'DevtronConnectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the input passed to a tool handler is invalid.
 * This usually means the AI sent a malformed request — shouldn't happen
 * often because Zod validates first, but useful as a safety net.
 */
export class ValidationError extends McpToolError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Type guard: checks if an unknown error is one of our custom errors.
 * Use this in catch blocks to safely access .code and .statusCode.
 *
 * Example:
 *   } catch (err) {
 *     if (isKnownError(err)) { return err.message; }
 *     throw err; // re-throw unknown errors
 *   }
 */
export function isKnownError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}