/**
 * Path validation for capsule selection. SPEC §10, I-relay §"Explicit selection".
 *
 * `selected_files` is a list of literal, workspace-relative paths — no globs, no
 * directories, no recursion. A glob is by construction a selection the caller did
 * not enumerate, and a recursive glob is one keystroke from shipping the whole
 * workspace including its `.env`. So a path with `*` or `?`, an absolute path,
 * a path with `..`, or a path naming a directory is rejected with `E_SCHEMA`.
 *
 * Containment is re-checked here even though policy also checks it: a capsule
 * leaves the machine, so the belt-and-braces is deliberate (I-relay §"Explicit
 * selection"). After realpath, a symlink that points outside the workspace root
 * is `E_PATH_ESCAPE` — the policy code, because that is exactly what it is.
 */

import { resolve, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { ErrorCode, TorosError } from '@toros/contracts';

/** True if the path looks absolute on either POSIX or Windows. */
function isAbsoluteLike(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return true;
  if (p.startsWith('\\')) return true;
  // Any Windows drive designator, whether rooted ("C:\", "C:/") or
  // DRIVE-RELATIVE ("C:relative.txt").
  //
  // The drive-relative form was missed here while `importCapsule` rejected it,
  // so createCapsule could resolve `C:relative.txt` to a file under the
  // workspace and then store that literal string as the tar entry name —
  // producing a capsule that Toros itself refuses to import. A path form has to
  // be judged the same on the way out as on the way in.
  if (/^[A-Za-z]:/.test(p)) return true;
  return false;
}

/**
 * Validate a single `selected_files` entry and return the resolved absolute
 * path inside `workspaceRoot`. Throws `E_SCHEMA` for the four explicit
 * rejections (glob, absolute, `..`, directory) and `E_PATH_ESCAPE` if a
 * symlink resolves outside the workspace root.
 */
export function validateSelectedPath(relPath: string, workspaceRoot: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      'selected_files entry must be a non-empty string',
      { path: relPath },
    );
  }
  // Reject glob metacharacters. The whole point of explicit selection is that
  // the caller enumerated the files; `*` or `?` means they did not.
  if (relPath.includes('*') || relPath.includes('?')) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `selected_files entry must not contain glob metacharacters: ${relPath}`,
      { path: relPath, reason: 'glob' },
    );
  }
  // Reject absolute paths. They cannot be workspace-relative by definition.
  if (isAbsoluteLike(relPath)) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `selected_files entry must be workspace-relative, got absolute path: ${relPath}`,
      { path: relPath, reason: 'absolute' },
    );
  }
  // Reject backslashes: paths are forward-slash separated and a backslash on
  // POSIX is a legal filename character that would defeat `..` segment checks.
  if (relPath.includes('\\')) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `selected_files entry must use forward slashes: ${relPath}`,
      { path: relPath, reason: 'backslash' },
    );
  }
  // Reject `..` segments. Segment-wise, after normalising on `/`.
  for (const seg of relPath.split('/')) {
    if (seg === '..') {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `selected_files entry must not contain '..': ${relPath}`,
        { path: relPath, reason: 'parent' },
      );
    }
  }

  const joined = resolve(workspaceRoot, relPath);
  // Containment on the literal join (no `..` can be present, but a Windows
  // drive letter in `relPath` would have been caught above).
  if (joined !== workspaceRoot && !joined.startsWith(workspaceRoot + sep)) {
    throw new TorosError(
      ErrorCode.E_PATH_ESCAPE,
      `selected_files entry resolves outside the workspace root: ${relPath}`,
      { path: relPath, resolved: joined, root: workspaceRoot },
    );
  }

  let st;
  try {
    st = statSync(joined);
  } catch {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `selected_files entry does not exist: ${relPath}`,
      { path: relPath, resolved: joined },
    );
  }
  // A directory is not a file. SPEC: "a path naming a directory" is E_SCHEMA.
  if (st.isDirectory()) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `selected_files entry names a directory, not a file: ${relPath}`,
      { path: relPath, resolved: joined, reason: 'directory' },
    );
  }

  // realpath closes the symlink loophole: a symlink inside the workspace that
  // points outside is contained on the literal join but escapes after resolve.
  const real = realpathSync(joined);
  if (real !== workspaceRoot && !real.startsWith(workspaceRoot + sep)) {
    throw new TorosError(
      ErrorCode.E_PATH_ESCAPE,
      `selected_files entry resolves (via symlink) outside the workspace root: ${relPath}`,
      { path: relPath, resolved: real, root: workspaceRoot },
    );
  }
  return real;
}
