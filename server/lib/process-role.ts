/**
 * Process-role marker. Imported FIRST by server/worker-main.ts (side effect only)
 * so that modules evaluated afterwards — notably server/db.ts — can tell the
 * BullMQ worker PARENT apart from the web server and from isolated job children.
 *
 * With WORKER_ISOLATION_ENABLED=true the parent no longer runs the pipeline, so
 * db.ts caps its pool at WORKER_ISOLATION_PARENT_PG_RESERVE and the remainder of
 * PG_POOL_MAX is partitioned across job children (docs/worker-isolation/DESIGN.md §4).
 * Children are forked with CIQ_PROCESS_ROLE=job-child and never import this file.
 */
if (!process.env.CIQ_PROCESS_ROLE) process.env.CIQ_PROCESS_ROLE = "worker-parent";

export {};
