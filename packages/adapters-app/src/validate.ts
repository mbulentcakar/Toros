import { ErrorCode, TorosError, type JsonValue } from '@toros/contracts';

/**
 * SPEC F constraints that every action enforces *before* a process is spawned,
 * so a schema rejection never reaches PowerShell and is observable as
 * `E_SCHEMA` regardless of host. These mirror the action `input_schema`s; the
 * registry would reject the same arguments, but this adapter defends in depth
 * because its tests reach it directly.
 */

/** `path` and `out_path` must already be policy-contained; the adapter never
 *  resolves them itself (SPEC F: "Never resolve paths yourself"). */
const WORKBOOK_EXT_RE = /\.(xlsx|xlsm)$/i;
const PDF_EXT_RE = /\.pdf$/i;

/**
 * The range grammar the spec pins: a cell or a cell pair, uppercase letters
 * only. No named ranges, no formulas, no expressions. A range Excel would
 * *evaluate* is an expression evaluator, which is not a bounded action.
 */
const RANGE_RE = /^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$/;

export function assertWorkbookPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !WORKBOOK_EXT_RE.test(path)) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      'path must be a string ending in .xlsx or .xlsm',
      { field: 'path' },
    );
  }
}

export function assertPdfPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !PDF_EXT_RE.test(path)) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      'out_path must be a string ending in .pdf',
      { field: 'out_path' },
    );
  }
}

export function assertSheetName(sheet: unknown): asserts sheet is string {
  if (typeof sheet !== 'string' || sheet.length === 0) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      'sheet must be a non-empty string',
      { field: 'sheet' },
    );
  }
}

function colToNum(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
}

/**
 * Parses a range validated against {@link RANGE_RE}. A single cell yields a
 * 1×1 area anchored at that cell. Returns the anchor (top-left) plus the area
 * dimensions, which `write_range` uses to place a 2-D `values` array.
 */
export interface ParsedRange {
  readonly startCol: number;
  readonly startRow: number;
  readonly endCol: number;
  readonly endRow: number;
  readonly rows: number;
  readonly cols: number;
}

export function parseRange(range: string): ParsedRange {
  const m = range.match(/^([A-Z]{1,3})([0-9]{1,7})(?::([A-Z]{1,3})([0-9]{1,7}))?$/);
  if (m === null) {
    // Unreachable when the caller has already run assertRangeShape.
    throw new TorosError(ErrorCode.E_SCHEMA, 'range is not a valid A1 range', { range });
  }
  const startCol = colToNum(m[1] as string);
  const startRow = Number.parseInt(m[2] as string, 10);
  let endCol = startCol;
  let endRow = startRow;
  if (m[3] !== undefined) {
    endCol = colToNum(m[3]);
    endRow = Number.parseInt(m[4] as string, 10);
  }
  if (endCol < startCol || endRow < startRow) {
    throw new TorosError(ErrorCode.E_SCHEMA, 'range end precedes start', { range });
  }
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  return { startCol, startRow, endCol, endRow, rows, cols };
}

/** Rejects anything that is not the pinned A1 grammar. Named ranges and
 *  formulas fail here before Excel is ever asked to evaluate them. */
export function assertRangeShape(range: unknown): asserts range is string {
  if (typeof range !== 'string' || !RANGE_RE.test(range)) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      'range must match ^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$ — no named ranges, no formulas',
      { field: 'range' },
    );
  }
}

/**
 * An unbounded `A1:XFD1048576` would otherwise hang the host. The area is
 * computed from the parsed range, never by asking Excel.
 */
export function assertRangeWithinCells(range: string, maxCells: number): ParsedRange {
  const parsed = parseRange(range);
  const cells = parsed.rows * parsed.cols;
  if (cells > maxCells) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `range addresses ${cells} cells, max_cells is ${maxCells}`,
      { field: 'range', cells, max_cells: maxCells },
    );
  }
  return parsed;
}

/** A cell value the adapter is willing to round-trip. Dates arrive as numbers;
 *  the pilot does not convert them. */
export type CellValue = string | number | boolean | null;

function isCellValue(v: JsonValue | undefined): v is CellValue {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * `write_range` values: a non-empty, rectangular 2-D array of primitives or
 * null. If the range is a full cell pair, the array shape must match it
 * exactly; if the range is a single cell, it is treated as an anchor and the
 * array defines the extent. Either way the written cell count is bounded by
 * `max_cells`.
 */
export function validateValues(values: unknown, parsed: ParsedRange, maxCells: number): CellValue[][] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TorosError(ErrorCode.E_SCHEMA, 'values must be a non-empty 2-D array', { field: 'values' });
  }
  const rows = values.length;
  let cols = 0;
  const out: CellValue[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const row = (values as readonly JsonValue[])[r];
    if (!Array.isArray(row) || row.length === 0) {
      throw new TorosError(ErrorCode.E_SCHEMA, `values[${r}] must be a non-empty array`, { field: 'values' });
    }
    if (cols === 0) cols = row.length;
    else if (row.length !== cols) {
      throw new TorosError(ErrorCode.E_SCHEMA, `values row ${r} is not rectangular`, { field: 'values' });
    }
    const outRow: CellValue[] = [];
    for (let c = 0; c < cols; c += 1) {
      const cell = (row as readonly JsonValue[])[c];
      if (!isCellValue(cell)) {
        throw new TorosError(
          ErrorCode.E_SCHEMA,
          `values[${r}][${c}] must be string, number, boolean, or null`,
          { field: 'values' },
        );
      }
      outRow.push(cell);
    }
    out.push(outRow);
  }

  // When the range spells out a cell pair, the array must match that area.
  if (parsed.rows !== 1 || parsed.cols !== 1) {
    if (rows !== parsed.rows || cols !== parsed.cols) {
      throw new TorosError(
        ErrorCode.E_SCHEMA,
        `values shape ${rows}x${cols} does not match range ${parsed.rows}x${parsed.cols}`,
        { field: 'values' },
      );
    }
  }

  const cells = rows * cols;
  if (cells > maxCells) {
    throw new TorosError(
      ErrorCode.E_SCHEMA,
      `values address ${cells} cells, max_cells is ${maxCells}`,
      { field: 'values', cells, max_cells: maxCells },
    );
  }
  return out;
}
