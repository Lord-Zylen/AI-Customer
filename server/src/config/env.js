import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// This file lives at server/src/config/env.js, so the project root is three
// directories up. Loading the project-root .env explicitly means env vars are
// found regardless of the current working directory (npm run dev, npm run
// seed --prefix server, or running node directly from server/).
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(projectRoot, '.env');

// dotenv never overrides variables already present in the environment, so
// docker-compose / real environment variables remain authoritative.
dotenv.config({ path: envFile });