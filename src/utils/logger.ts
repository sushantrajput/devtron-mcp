// src/utils/logger.ts
// CRITICAL: All output MUST go to stderr, never stdout.
// MCP protocol uses stdout exclusively for JSON communication.
// Any non-JSON text on stdout breaks the protocol and causes JSON parse errors.

import winston from 'winston';
import { config } from '../config/index.js';

const isDevelopment = process.env['NODE_ENV'] !== 'production';

export const logger = winston.createLogger({
  level: config.server.logLevel,

  defaultMeta: {
    service: config.server.name,
    version: config.server.version,
  },

  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    isDevelopment
      ? winston.format.combine(
          winston.format.colorize({ all: true }),
          // Explicitly type the info parameter to fix the 'implicit any' errors
          winston.format.printf((info: winston.Logform.TransformableInfo) => {
            const { timestamp, level, message, service, version, ...rest } = info as {
              timestamp: string;
              level: string;
              message: string;
              service: string;
              version: string;
              [key: string]: unknown;
            };
            const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
            return `${timestamp} [${level}] ${message}${extra}`;
          })
        )
      : winston.format.json()
  ),

  transports: [
    new winston.transports.Console({
      // Force ALL log levels to stderr — never stdout
      // This is non-negotiable for MCP servers
      stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
    }),
  ],

  exitOnError: false,
});