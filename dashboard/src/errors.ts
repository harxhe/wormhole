/** Errors that should be reported to the dashboard client as a 4xx response. */
export class DashboardError extends Error {
  /** Machine-readable code, also shown in the UI for client errors. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DashboardError";
    this.code = code;
  }
}
