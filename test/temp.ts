import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
// macOS temp roots may be aliases; strict state ownership requires canonical paths.
export const tempPrefix = (prefix: string) => path.join(fs.realpathSync(tmpdir()), prefix);
