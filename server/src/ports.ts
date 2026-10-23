/**
 * Allocates public ports from a configured inclusive range. Ports are reserved
 * while a TCP tunnel is alive and returned when it closes.
 */
export class PortPool {
  private readonly used = new Set<number>();
  private next: number;

  constructor(
    private readonly start: number,
    private readonly end: number
  ) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
      throw new RangeError("invalid port range");
    }
    this.next = start;
  }

  get size(): number {
    return this.end - this.start + 1;
  }

  get inUse(): number {
    return this.used.size;
  }

  /** Reserve the next free port, or `undefined` when the range is exhausted. */
  acquire(): number | undefined {
    for (let i = 0; i < this.size; i++) {
      const offset = (this.next - this.start + i) % this.size;
      const port = this.start + offset;
      if (!this.used.has(port)) {
        this.used.add(port);
        this.next = port === this.end ? this.start : port + 1;
        return port;
      }
    }
    return undefined;
  }

  release(port: number): void {
    this.used.delete(port);
  }
}
