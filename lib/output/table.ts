import { colors, stripAnsi } from "../colors.js";

type Align = "left" | "right" | "center";
type ColorKey = keyof typeof colors;

interface ColumnOptions {
  align?: Align;
  width?: "auto" | number;
  minWidth?: number;
  color?: ColorKey;
  colorFn?: (val: unknown) => string;
  padChar?: string;
}

interface Column {
  align: Align;
  width: "auto" | number;
  minWidth: number;
  color?: ColorKey;
  colorFn?: (val: unknown) => string;
  padChar: string;
}

export class TableBuilder {
  private columns: Column[] = [];
  private rows: unknown[][] = [];

  column(options: ColumnOptions = {}): this {
    const column: Column = {
      align: options.align ?? "left",
      width: options.width ?? "auto",
      minWidth: options.minWidth ?? 0,
      color: options.color,
      colorFn: options.colorFn,
      padChar: options.padChar ?? " ",
    };
    this.columns.push(column);
    return this;
  }

  addRow(data: unknown[]): this {
    if (data.length !== this.columns.length) {
      throw new Error(
        `Row length mismatch: expected ${this.columns.length} columns, got ${data.length}`,
      );
    }
    this.rows.push([...data]);
    return this;
  }

  private calculateColumnWidths(): Map<number, number> {
    const widths = new Map<number, number>();

    for (const [colIndex, col] of this.columns.entries()) {
      let width = col.minWidth;

      if (typeof col.width === "number") {
        width = Math.max(width, col.width);
      } else if (col.width === "auto") {
        for (const row of this.rows) {
          const val = row[colIndex];
          if (val !== undefined && val !== "") {
            const str = String(val);
            const visibleWidth = stripAnsi(str).length;
            width = Math.max(width, visibleWidth);
          }
        }
      }

      widths.set(colIndex, width);
    }

    return widths;
  }

  private formatCell(value: unknown, col: Column, width: number): string {
    const str = value === undefined || value === "" ? "" : String(value);
    const visibleWidth = stripAnsi(str).length;
    const padChar = col.padChar;

    let padded: string;
    if (col.align === "right") {
      const paddingNeeded = Math.max(0, width - visibleWidth);
      padded = padChar.repeat(paddingNeeded) + str;
    } else if (col.align === "center") {
      const leftPad = Math.floor((width - visibleWidth) / 2);
      const rightPad = width - visibleWidth - leftPad;
      padded = padChar.repeat(leftPad) + str + padChar.repeat(rightPad);
    } else {
      padded = str.padEnd(width, padChar);
    }

    if (col.colorFn && value !== undefined && value !== "") {
      return col.colorFn(value);
    }

    if (col.color && colors[col.color]) {
      return colors[col.color](padded);
    }

    return padded;
  }

  render(): string[] {
    if (this.rows.length === 0) {
      return [];
    }

    const widths = this.calculateColumnWidths();
    const lines: string[] = [];

    for (const row of this.rows) {
      const cells: string[] = [];

      for (const [colIndex, col] of this.columns.entries()) {
        const width = widths.get(colIndex)!;
        const value = row[colIndex];
        const formatted = this.formatCell(value, col, width);
        cells.push(formatted);
      }

      lines.push(cells.join(" "));
    }

    return lines;
  }

  clear(): this {
    this.rows = [];
    return this;
  }

  reset(): this {
    this.columns = [];
    this.rows = [];
    return this;
  }
}

export function createTable(): TableBuilder {
  return new TableBuilder();
}
