/*
 * Executors of validated pending actions (ticket 1.6). Runs ONLY after a human
 * approved (validatedBy set) — never from the agent loop. MVP executors are
 * SIMULATED (no real SMTP / accounting write yet): they mark the action done
 * and return metadata-only results. Real side effects will land behind this
 * exact interface.
 */

export type ActionExecutor = (
  payload: unknown,
  context: { tenantId: string },
) => Promise<unknown>;

export type ExecutorRegistry = Record<string, ActionExecutor>;

export const defaultExecutors: ExecutorRegistry = {
  send_dunning: () => Promise.resolve({ sent: true, simulated: true }),
  book_invoice: () => Promise.resolve({ booked: true, simulated: true }),
  create_quote: () => Promise.resolve({ created: true, simulated: true }),
  submit_reconciliation: () => Promise.resolve({ submitted: true, simulated: true }),
};
