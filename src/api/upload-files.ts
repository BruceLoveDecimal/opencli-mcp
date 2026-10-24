/** Upload paths belong to the browser host. Reject missing or unreadable files before any page action. */
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { ActionError } from './errors.js';

export async function inspectUploadFiles(files: string[] | undefined): Promise<Array<{ name: string; size: number }>> {
  if (!files?.length || files.some((file) => !isAbsolute(file))) throw new ActionError('invalid_args', 'upload needs non-empty absolute file paths.');
  const result: Array<{ name: string; size: number }> = [];
  for (const file of files) {
    try {
      // Stat first: opening a FIFO for reading can otherwise hang indefinitely.
      if (!(await stat(file)).isFile()) throw new Error('not a regular file');
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('not a regular file');
        result.push({ name: basename(file), size: info.size });
      } finally { await handle.close(); }
    } catch {
      throw new ActionError('upload_file_unavailable', 'An upload file does not exist, is not a regular file, or cannot be read.', 'Prepare files on the browser host before uploading. Do not retry a missing path.');
    }
  }
  return result;
}
