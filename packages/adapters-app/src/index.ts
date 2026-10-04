/**
 * @toros/adapters-app — Phase 1 pilot desktop adapter for Microsoft Excel.
 *
 * SPEC F: exactly four actions (`inspect_workbook`, `read_range`,
 * `write_range`, `export_pdf`), driven through PowerShell COM automation (SPEC
 * §4.3 tier 3) with a fixed, parameter-free script that reads its inputs as
 * JSON data — never interpolated source text. No `xlsx`/`exceljs`/COM-wrapper
 * dependency; `@toros/contracts` is the only dependency.
 */
export { createExcelAdapter, EXCEL_ACTION_IDS, powershellPath, type ExcelAdapterOptions } from './adapter.js';
